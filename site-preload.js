'use strict';

/**
 * 站点视图预加载脚本（contextIsolation 开启，运行在隔离世界）
 *
 * 目前只服务于 Google 登录兼容，两件事：
 *   1) 给 navigator.userAgentData 补上 "Google Chrome" 品牌 —— Electron 的品牌列表只有
 *      "Chromium"，真实 Chrome 一定同时含 "Google Chrome"，Google 登录页会据此判定为
 *      嵌入式浏览器并拦截（"请尝试使用其他浏览器"）。请求头侧的对应补丁在 main.js。
 *   2) 关掉 WebAuthn —— Google 默认走 passkey，且用条件式 UI（mediation:'conditional'）
 *      在进入登录页时就自动触发，Chromium 在 Windows 上会直接拉起系统"安全密钥/Windows Hello"
 *      对话框。摘掉 PublicKeyCredential 后 Google 会回落到密码登录。
 *
 * 非 Google 域名下本脚本不做任何事。
 */

const { contextBridge, webFrame } = require('electron');

// 覆盖 google.com / google.cn / google.com.hk / google.co.jp 等各地区域名
const GOOGLE_HOST_RE = /(^|\.)(google\.[a-z]{2,3}(\.[a-z]{2})?|youtube\.com)$/i;

/**
 * 把函数注入页面主世界执行。
 * contextIsolation 下预加载脚本在隔离世界，直接改 navigator 影响不到页面脚本，
 * 必须显式跨到主世界；两条路径都在 document_start 时机、页面脚本之前执行。
 */
function runInMainWorld(func, args) {
  try {
    if (typeof contextBridge.executeInMainWorld === 'function') {
      // Electron 35+ 的官方入口，隔离世界下最干净的注入方式
      return contextBridge.executeInMainWorld({ func, args });
    }
  } catch (e) {
    /* 落到下面的兜底 */
  }
  // 兜底：老版本 / executeInMainWorld 不可用时用字符串求值
  return webFrame.executeJavaScript('(' + func.toString() + ').apply(null,' + JSON.stringify(args) + ')');
}

/**
 * 在主世界执行的补丁本体。
 * 注意：executeInMainWorld 要求函数自包含，不能引用外层作用域，所有输入走 args。
 */
function patchGoogleCompat(brandVersion, fullVersion) {
  const CHROME = 'Google Chrome';

  /** 品牌列表补 Google Chrome（保留 Chromium 自己生成的 GREASE 项，最接近真实 Chrome） */
  function withChrome(list, version) {
    const arr = (list || []).map((b) => ({ brand: b.brand, version: b.version }));
    if (!arr.some((b) => b.brand === CHROME)) arr.push({ brand: CHROME, version: version });
    return arr;
  }

  try {
    // 注意：navigator.userAgentData 每次访问返回的不是同一个对象，
    // 在实例上 defineProperty 会被下一次访问拿到的新对象绕过（实测无效），必须打在原型上。
    const uaData = navigator.userAgentData;
    const proto = uaData && Object.getPrototypeOf(uaData);
    const brandsDesc = proto && Object.getOwnPropertyDescriptor(proto, 'brands');

    if (brandsDesc && brandsDesc.get) {
      const originalBrands = brandsDesc.get;
      Object.defineProperty(proto, 'brands', {
        configurable: true,
        enumerable: brandsDesc.enumerable,
        get: function () {
          return withChrome(originalBrands.call(this), brandVersion);
        },
      });
    }

    if (proto && typeof proto.getHighEntropyValues === 'function') {
      const originalHighEntropy = proto.getHighEntropyValues;
      Object.defineProperty(proto, 'getHighEntropyValues', {
        configurable: true,
        writable: true,
        value: function (hints) {
          return originalHighEntropy.call(this, hints).then((values) => {
            if (values.brands) values.brands = withChrome(values.brands, brandVersion);
            if (values.fullVersionList) {
              values.fullVersionList = withChrome(values.fullVersionList, fullVersion);
            }
            return values;
          });
        },
      });
    }

    if (proto && typeof proto.toJSON === 'function') {
      const originalToJSON = proto.toJSON;
      Object.defineProperty(proto, 'toJSON', {
        configurable: true,
        writable: true,
        value: function () {
          const values = originalToJSON.call(this);
          if (values && values.brands) values.brands = withChrome(values.brands, brandVersion);
          return values;
        },
      });
    }
  } catch (e) {
    /* 站点不读 userAgentData 时无所谓，不打断页面 */
  }

  try {
    // 摘掉 WebAuthn 特性检测入口：Google 检测不到就直接给密码表单
    delete window.PublicKeyCredential;

    // 双保险：即使站点缓存了 credentials.get 也拒掉 publicKey 请求。
    // 只拦 publicKey，password / federated（密码自动填充）保持可用。
    const container = navigator.credentials;
    if (container) {
      const reject = () =>
        Promise.reject(new DOMException('WebAuthn disabled by AI Hub', 'NotAllowedError'));
      for (const method of ['get', 'create']) {
        const original = container[method] && container[method].bind(container);
        if (!original) continue;
        Object.defineProperty(container, method, {
          configurable: true,
          writable: true,
          value: function (options) {
            if (options && options.publicKey) return reject();
            return original(options);
          },
        });
      }
    }
  } catch (e) {
    /* ignore */
  }

  // 3) 补齐 window.chrome：真实 Chrome 上它有 app / csi / loadTimes 三个成员，
  //    Electron 里是个空对象 —— 这是判定"嵌入式/自动化浏览器"最经典的信号之一。
  try {
    const chrome = window.chrome || (window.chrome = {});

    if (!chrome.app) {
      chrome.app = {
        isInstalled: false,
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
        getDetails: function () {
          return null;
        },
        getIsInstalled: function () {
          return false;
        },
        installState: function (callback) {
          if (typeof callback === 'function') callback('not_installed');
        },
        runningState: function () {
          return 'cannot_run';
        },
      };
    }

    // 时间戳单位与真实实现一致：epoch 秒（performance.timing 是 epoch 毫秒）
    const seconds = (ms) => (ms > 0 ? ms / 1000 : 0);

    if (!chrome.csi) {
      chrome.csi = function () {
        const timing = performance.timing || {};
        return {
          onloadT: timing.domContentLoadedEventEnd || 0,
          pageT: performance.now(),
          startE: timing.navigationStart || 0,
          tran: 15,
        };
      };
    }

    if (!chrome.loadTimes) {
      chrome.loadTimes = function () {
        const timing = performance.timing || {};
        const nav = (performance.getEntriesByType('navigation') || [])[0];
        const protocol = (nav && nav.nextHopProtocol) || 'h2';
        return {
          commitLoadTime: seconds(timing.responseStart),
          connectionInfo: protocol,
          finishDocumentLoadTime: seconds(timing.domContentLoadedEventEnd),
          finishLoadTime: seconds(timing.loadEventEnd),
          firstPaintAfterLoadTime: 0,
          firstPaintTime: seconds(timing.responseStart),
          navigationType: 'Other',
          npnNegotiatedProtocol: protocol,
          requestTime: seconds(timing.requestStart),
          startLoadTime: seconds(timing.navigationStart),
          wasAlternateProtocolAvailable: false,
          wasFetchedViaSpdy: protocol !== 'http/1.1',
          wasNpnNegotiated: protocol !== 'http/1.1',
        };
      };
    }
  } catch (e) {
    /* ignore */
  }

  // 4) 权限状态对齐：Electron 默认把所有权限查询都答成 granted，
  //    真实 Chrome 在新站点上是 default / prompt —— 全 granted 是很扎眼的自动化特征。
  try {
    if (typeof Notification !== 'undefined' && Notification.permission !== 'default') {
      Object.defineProperty(Notification, 'permission', {
        configurable: true,
        get: () => 'default',
      });
    }

    const perms = navigator.permissions;
    if (perms && typeof perms.query === 'function') {
      const PROMPTABLE = ['notifications', 'geolocation'];
      const originalQuery = perms.query;
      Object.defineProperty(perms, 'query', {
        configurable: true,
        writable: true,
        value: function (descriptor) {
          return originalQuery.call(this, descriptor).then((status) => {
            const name = descriptor && descriptor.name;
            if (PROMPTABLE.indexOf(name) >= 0 && status.state === 'granted') {
              // query() 每次返回新对象，在这个实例上遮蔽即可
              Object.defineProperty(status, 'state', { configurable: true, get: () => 'prompt' });
            }
            return status;
          });
        },
      });
    }
  } catch (e) {
    /* ignore */
  }

  // 5) navigator.languages：Electron 给的是 ["zh-CN","zh-Hans-CN"]，
  //    真实 Chrome 是 ["zh-CN","zh"]（主语言 + 基础语言）。主进程会同步改写 Accept-Language。
  try {
    const primary = navigator.language || 'en-US';
    const base = primary.split('-')[0];
    const wanted = Object.freeze(base && base !== primary ? [primary, base] : [primary]);
    const current = Array.prototype.slice.call(navigator.languages || []);
    if (current.join(',') !== wanted.join(',')) {
      Object.defineProperty(Navigator.prototype, 'languages', {
        configurable: true,
        enumerable: true,
        get: () => wanted,
      });
    }
  } catch (e) {
    /* ignore */
  }

  // 供主进程自检用的标记（主进程 executeJavaScript 读取）
  try {
    window.__aihubGoogleCompat = { brands: brandVersion, webauthn: 'disabled' };
  } catch (e) {
    /* ignore */
  }
  return true;
}
try {
  if (GOOGLE_HOST_RE.test(location.hostname)) {
    // 沙箱预加载里 process.versions 可用；万一取不到就从 UA 回推大版本
    const uaMajor = (navigator.userAgent.split('Chrome/')[1] || '').split('.')[0];
    const full = (process && process.versions && process.versions.chrome) || uaMajor + '.0.0.0';
    runInMainWorld(patchGoogleCompat, [String(full).split('.')[0], String(full)]);
  }
} catch (e) {
  console.error('[aihub] site-preload failed:', e);
}
