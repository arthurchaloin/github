const {basename, extname, resolve} = require('path');
const {stat, readFile} = require('fs-extra');
const {isPlainObject} = require('lodash');
const parseGithubUrl = require('parse-github-url');
const mime = require('mime');
const debug = require('debug')('semantic-release:github');
const globAssets = require('./glob-assets.js');
const resolveConfig = require('./resolve-config');
const getClient = require('./get-client');

module.exports = async (pluginConfig, context) => {
  const {
    cwd,
    options: {branch},
    nextRelease: {gitTag, notes},
    logger,
  } = context;
  const {githubToken, githubUrl, githubApiPathPrefix, proxy, assets, repositoryUrl} = resolveConfig(
    pluginConfig,
    context
  );
  const {name: repo, owner} = parseGithubUrl(repositoryUrl);
  const github = getClient({githubToken, githubUrl, githubApiPathPrefix, proxy});

  /* eslint-disable camelcase */
  const releaseData = {
    owner,
    repo,
    tag_name: gitTag,
    name: gitTag,
    target_commitish: branch,
    body: notes,
  };
  /* eslint-enable */

  debug('release owner: %o', owner);
  debug('release repo: %o', repo);
  debug('release name: %o', gitTag);
  debug('release branch: %o', branch);

  // When there are no assets, we publish a release directly
  if (!assets || assets.length === 0) {
    const {
      data: {html_url: url},
    } = await github.repos.createRelease(releaseData);

    logger.log('Published GitHub release: %s', url);
    return {url, name: 'GitHub release'};
  }

  // We'll create a draft release, append the assets to it, and then publish it.
  // This is so that the assets are available when we get a Github release event.
  const draftRelease = {...releaseData, draft: true};

  const {
    data: {html_url: url, upload_url: uploadUrl, id: releaseId},
  } = await github.repos.createRelease(draftRelease);

  // Append assets to the release
  const globbedAssets = await globAssets(context, assets);
  debug('globed assets: %o', globbedAssets);

  await Promise.all(
    globbedAssets.map(async asset => {
      const filePath = isPlainObject(asset) ? asset.path : asset;
      let file;

      try {
        file = await stat(resolve(cwd, filePath));
      } catch (error) {
        logger.error('The asset %s cannot be read, and will be ignored.', filePath);
        return;
      }

      if (!file || !file.isFile()) {
        logger.error('The asset %s is not a file, and will be ignored.', filePath);
        return;
      }

      const fileName = asset.name || basename(filePath);
      const upload = {
        url: uploadUrl,
        file: await readFile(resolve(cwd, filePath)),
        name: fileName,
        headers: {
          'content-type': mime.getType(extname(fileName)) || 'text/plain',
          'content-length': file.size,
        },
      };

      debug('file path: %o', filePath);
      debug('file name: %o', fileName);

      if (isPlainObject(asset) && asset.label) {
        upload.label = asset.label;
      }

      const {
        data: {browser_download_url: downloadUrl},
      } = await github.repos.uploadReleaseAsset(upload);
      logger.log('Published file %s', downloadUrl);
    })
  );

  /* eslint-disable camelcase */
  const release = {
    owner,
    repo,
    release_id: releaseId,
    draft: false,
  };
  /* eslint-enable */

  await github.repos.updateRelease(release);

  logger.log('Published GitHub release: %s', url);
  return {url, name: 'GitHub release'};
};
