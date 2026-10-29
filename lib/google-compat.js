'use strict';

/**
 * UA 清理 + Google 登录兼容层（请求头侧）。
 *
 * 症状：内嵌浏览器登录 Google 账号（Gemini）时，先弹 Windows 安全密钥对话框，
 *       关掉后输账号又被拦："请尝试使用其他浏览器"。
 * 成因：Electron 的 UA 客户端提示品牌列表只有 "Chromium"，真实 Chrome 一定同时含
 *       "Google Chrome"，Google 据此判定为嵌入式浏览器。安全密钥弹窗则是 Google 的
 *       passkey 条件式 UI 触发了 Chromium 的 Windows Hello 集成。
 * 对策：请求头侧在这里补齐 Chrome 品牌；页面侧（navigator.userAgentData + 关 WebAuthn）
 *       由 site-preload.js 负责，两侧必须一致，否则对不上更可疑。
 */

const { app } = require('electron');
const { PRODUCT_NAME } = require('./config');

const CHROME_FULL_VERSION = process.versions.chrome; // 150.0.7871.212
const CHROME_MAJOR_VERSION = CHROME_FULL_VERSION.split('.')[0]; // 150

// google.com / google.cn / google.com.hk / google.co.jp 等各地区域名，外加 Google 自家的静态资源域。
// 比 site-preload.js 里的范围大：请求头要覆盖页面加载的静态资源/接口域名，
// 而页面侧补丁只需要在 Google 自己的页面上生效。
const GOOGLE_HOST_RE =
  /(^|\.)(google\.[a-z]{2,3}(\.[a-z]{2})?|gstatic\.com|googleapis\.com|googleusercontent\.com|youtube\.com)$/i;

// 去掉 Electron / 应用标识，让第三方站点识别为普通 Chrome，减少风控/兼容问题。
// 另外把 Chrome 版本号降到 major.0.0.0：真实 Chrome 自 110 起做 UA reduction，
// 只报大版本；带完整版本号（如 150.0.7871.212）反而是嵌入式浏览器的明显指纹。
function cleanUA(ua) {
  return ua
    .replace(new RegExp('\\s' + PRODUCT_NAME.replace(/\s+/g, '') + '/[\\d.]+', 'i'), '')
    .replace(/\sElectron\/[\d.]+/i, '')
    .replace(/\sElectron\//i, ' ')
    .replace(/\bChrome\/(\d+)[\d.]*/i, 'Chrome/$1.0.0.0');
}

/** Chromium 报的平台名（真实 Chrome 的 Sec-CH-UA-Platform 取值） */
function chromePlatform() {
  if (process.platform === 'darwin') return 'macOS';
  if (process.platform === 'win32') return 'Windows';
  return 'Linux';
}

/**
 * 往品牌列表里补一项 "Google Chrome"。
 * 保留 Chromium 自己生成的 GREASE 项（如 "Not;A=Brand"）而不是整串重写，
 * 这样和浏览器每个版本自带的伪装项保持一致，最接近真实 Chrome。
 */
function withChromeBrand(value, version) {
  const entry = '"Google Chrome";v="' + version + '"';
  if (!value) return '"Not;A=Brand";v="8", "Chromium";v="' + version + '", ' + entry;
  if (/"Google Chrome"/i.test(value)) return value;
  return value + ', ' + entry;
}

/**
 * Accept-Language 头：真实 Chrome 发 "zh-CN,zh;q=0.9"（主语言 + 基础语言），
 * Electron 只发 "zh-CN"。与 site-preload.js 里改写的 navigator.languages 保持一致。
 */
function buildAcceptLanguage() {
  let locale = 'en-US';
  try {
    locale = app.getLocale() || locale;
  } catch (e) {
    /* app 未 ready 时兜底 */
  }
  const base = locale.split('-')[0];
  return base && base !== locale ? locale + ',' + base + ';q=0.9' : locale;
}

/**
 * 给站点 session 挂上 Google 请求头补丁。
 * 只处理 Google 域名，其余请求原样透传，避免影响别的站点。
 */
function attachGoogleCompat(ses) {
  const acceptLanguage = buildAcceptLanguage();
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    let hostname = '';
    try {
      hostname = new URL(details.url).hostname;
    } catch (e) {
      /* 非法 URL：原样放行 */
    }
    if (!GOOGLE_HOST_RE.test(hostname)) {
      callback({ requestHeaders: details.requestHeaders });
      return;
    }

    const headers = details.requestHeaders;
    // Chromium 发出的头大小写不固定，按小写名找到实际的 key
    const keyOf = (name) =>
      Object.keys(headers).find((k) => k.toLowerCase() === name) || name;

    // 低熵提示：真实 Chrome 每个请求都带，缺了同样可疑，直接补齐
    const uaKey = keyOf('sec-ch-ua');
    headers[uaKey] = withChromeBrand(headers[uaKey], CHROME_MAJOR_VERSION);
    headers[keyOf('sec-ch-ua-mobile')] = '?0';
    headers[keyOf('sec-ch-ua-platform')] = '"' + chromePlatform() + '"';
    headers[keyOf('accept-language')] = acceptLanguage;

    // 高熵提示：只有站点用 Accept-CH 要过才会出现，没有就别凭空加（凭空加本身才反常）
    const fullListKey = keyOf('sec-ch-ua-full-version-list');
    if (headers[fullListKey]) {
      headers[fullListKey] = withChromeBrand(headers[fullListKey], CHROME_FULL_VERSION);
    }

    callback({ requestHeaders: headers });
  });
}

module.exports = { cleanUA, attachGoogleCompat };
