/** Where the site points. One place, so a moved URL changes once. */
export const REPO = 'JeanIsahakyan/theodore';
export const GITHUB = `https://github.com/${REPO}`;
export const DOCS = `${GITHUB}#readme`;
export const RELEASES = `${GITHUB}/releases`;
export const RELEASES_LATEST = `${GITHUB}/releases/latest`;
export const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
export const LICENSE = `${GITHUB}/blob/main/LICENSE`;
export const CLOUD_LICENSE = `${GITHUB}/blob/main/cloud/LICENSE.md`;
export const ISSUES = `${GITHUB}/issues`;
export const WEB_APP = 'https://app.theodore.cloud';
export const CONTACT_EMAIL = 'hello@theodore.cloud';
export const DOC = (file: string) => `${GITHUB}/blob/main/docs/${file}`;
