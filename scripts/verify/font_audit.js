// 审计各表单控件在手机视口下的字号（iOS <16px 会自动缩放）
const { chromium, devices } = require('playwright');
(async()=>{
  const b=await chromium.launch();
  const p=await (await b.newContext({...devices['iPhone 13']})).newPage();
  await p.goto('https://nss-solar-points.com/',{waitUntil:'networkidle'});
  const bad=[];
  for (const [name,sel] of [['登录框','#loginForm input'],['全局input','input:not([type=hidden])'],['textarea','textarea'],['select','select']]) {
    const sizes=await p.evaluate(s=>Array.from(document.querySelectorAll(s))
      .map(e=>getComputedStyle(e).fontSize).filter(Boolean), sel);
    const uniq=[...new Set(sizes)];
    const small=uniq.filter(x=>parseFloat(x)<16);
    console.log(`${name.padEnd(10)} 字号: ${uniq.join(', ')||'(无)'} ${small.length?'❌ <16px: '+small.join(','):'✅'}`);
    if(small.length) bad.push(name);
  }
  console.log(bad.length? `\n需修复: ${bad.join(', ')}` : '\n✅ 手机端字号全部达标');
  await b.close();
})();
