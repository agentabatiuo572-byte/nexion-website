import assert from 'node:assert/strict';
const base = process.argv[2] ?? 'https://uvel.ai';
const request = (route, options={}) => fetch(base+route,{redirect:'manual',signal:AbortSignal.timeout(15000),...options});
for (const route of ['/','/vi/','/admin/','/admin/login','/api/health']) { const res=await request(route);assert.equal(res.status,200,route); }
for (const route of ['/.publish-stamp.json','/%2epublish-stamp.json','/.env','/zh/','/documents/uvel-whitepaper-v1.3-zh.pdf']) assert.equal((await request(route)).status,404,route);
assert.equal((await request('/api/me')).status,401);
const health=await (await request('/api/health')).json();assert.equal(health.environment,'production');assert.equal(health.ok,true);
const admin=await request('/admin/');assert.equal(admin.headers.get('cache-control'),'no-store');assert.match(await admin.text(),/script/);
assert.equal((await request('/api/auth/login',{method:'POST',headers:{origin:'https://wrong.invalid','content-type':'application/json'},body:'{}'})).status,403);
const pdf=await request('/documents/uvel-whitepaper-v1.3-en.pdf',{headers:{range:'bytes=0-99'}});assert.equal(pdf.status,206);assert.match(pdf.headers.get('content-type'),/application\/pdf/);
console.log('Live HTTPS, admin, production API, authorization, origin, private paths and PDF range checks passed');
