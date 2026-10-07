// 审计 PWA 安装就绪度（对生产只读）
const { chromium, devices } = require('playwright');
(async()=>{
  const b = await chromium.launch();
  // iPhone 视口
  const ctx = await b.newContext({ ...devices['iPhone 13'] });
  const p = await ctx.newPage();
  await p.goto('https://nss-solar-points.com/', {waitUntil:'networkidle', timeout:20000});
  const info = await p.evaluate(()=>{
    const link = n => document.querySelector(`link[rel="${n}"], link[rel="${n}"][sizes]`);
    const al = document.querySelector('link[rel="apple-touch-icon"]');
    const man = document.querySelector('link[rel="manifest"]');
    return {
      appleTouchIcon: al ? al.getAttribute('href') : null,
      icons: Array.from(document.querySelectorAll('link[rel="icon"]')).map(x=>({href:x.getAttribute('href'),sizes:x.getAttribute('sizes'),type:x.getAttribute('type')})),
      manifest: man ? man.getAttribute('href') : null,
      themeColor: document.querySelector('meta[name=theme-color]')?.content,
      swRegistered: 'serviceWorker' in navigator,
      standalone: matchMedia('(display-mode: standalone)').matches,
    };
  });
  console.log('=== 生产 PWA 现状 ===');
  console.log('apple-touch-icon:', info.appleTouchIcon || '❌ 缺失（iOS 无法添加到主屏）');
  console.log('favicon/图标:', info.icons.length? JSON.stringify(info.icons):'❌ 无');
  console.log('manifest:', info.manifest||'❌');
  console.log('theme-color:', info.themeColor||'❌');
  console.log('viewport 移动端适配:', await p.locator('meta[name=viewport]').count() ? '✅' : '❌');
  // 检查输入框字号（iOS 聚焦缩放问题）
  const fontSize = await p.evaluate(()=>{
    const i=document.querySelector('input[name=username]');
    return i?getComputedStyle(i).fontSize:null;
  });
  console.log('登录框字号:', fontSize, parseFloat(fontSize)<16?'⚠️ <16px，iOS 聚焦会缩放页面':'✅ ≥16px');
  await b.close();
})();
