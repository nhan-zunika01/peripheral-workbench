import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const powershell = process.env.PWSH || 'pwsh.exe';
test('hardware gate is an explicit check outside the portable Node test glob', () => {
  assert.ok(!fileURLToPath(import.meta.url).endsWith('.test.mjs'));
});
test('hardware CLI requires an explicit operation before connecting', () => {
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-File', 'scripts/verify-companion-hardware.ps1'], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /Usage:.*ReadOnly/);
});
test('real PowerShell transport uses pinned headers and sends a failed POST once', async () => {
  const requests=[];
  const server=http.createServer(async (req,res) => {
    let text=''; for await (const chunk of req) text+=chunk;
    requests.push({method:req.method,path:req.url,origin:req.headers.origin,authorization:req.headers.authorization,body:text && JSON.parse(text)});
    res.setHeader('X-Razer-Companion-Backend','rust'); res.setHeader('X-Razer-Companion-Writes','1');
    res.writeHead(req.method==='POST'?504:200,{'Content-Type':'application/json'});
    res.end(JSON.stringify(req.method==='POST'?{error:'unknown'}:{token:'a'.repeat(64)}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const endpoint=`http://127.0.0.1:${server.address().port}`;
    const command=`. ./scripts/verify-companion-hardware.ps1; if(!(Get-Command Invoke-CompanionRequest).Parameters.ContainsKey('TestEndpoint')){throw 'ephemeral transport seam missing'}; $p=Invoke-CompanionRequest GET '/api/pair' $null 'https://mouse.example' '' '${endpoint}'; if($p.backend -ne 'rust'){throw 'marker lost'}; try { Invoke-CompanionRequest POST '/api/settings' @{deviceId=('b'*24);id='dpi';value=@{x=900;y=900};expectedValue=@{x=800;y=800}} 'https://mouse.example' ('a'*64) '${endpoint}'; throw 'expected failure' } catch { if($_.Exception.Message -notlike '*HTTP 504*'){throw} }`;
    await promisify(execFile)(powershell,['-NoProfile','-NonInteractive','-Command',command+'; exit 0'],{cwd:root,windowsHide:true,timeout:10000});
    assert.equal(requests.length,2);
    assert.deepEqual(requests.map(r=>r.method),['GET','POST']);
    assert.equal(requests[0].origin,'https://mouse.example');
    assert.equal(requests[1].authorization,`Bearer ${'a'.repeat(64)}`);
    assert.deepEqual(requests[1].body,{deviceId:'b'.repeat(24),id:'dpi',value:{x:900,y:900},expectedValue:{x:800,y:800}});
  } finally { await new Promise(resolve=>server.close(resolve)); }
});
test('hardware workflow rejects unpinned inputs without transport calls', () => {
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-File', 'tests/support/hardware-gates-check.ps1'], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
for (const scenario of ['crash','stale','lease']) test(`hardware ${scenario} regression`, () => {
  const result=spawnSync(powershell,['-NoProfile','-NonInteractive','-File','tests/support/hardware-gates-check.ps1','-Scenario',scenario],{cwd:root,encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stdout+result.stderr);
});
test('public hardware CLI rejects unknown parameters during binding', () => {
  const result=spawnSync(powershell,['-NoProfile','-NonInteractive','-File','scripts/verify-companion-hardware.ps1','-ReadOnly','-Endpoint','http://127.0.0.1:1'],{cwd:root,encoding:'utf8',windowsHide:true});
  assert.notEqual(result.status,0);
  assert.match(result.stdout+result.stderr,/parameter cannot be found.*Endpoint/i);
});
test('real HTTP and G1 baseline clones preserve date-shaped JSON strings', async () => {
  const axes={x:{type:'number',min:100,max:35000,integer:true},y:{type:'number',min:100,max:35000,integer:true}};
  const state={selectedDeviceId:'b'.repeat(24),connected:true,devices:[{id:'b'.repeat(24),name:'Razer Viper V3 Pro SE',supported:true},{id:'c'.repeat(24),name:'2026-11-13T12:00:00Z',supported:false}],settings:[{id:'firmware',type:'string',writable:false,value:'1.0'},{id:'dpi',type:'object',properties:axes,writable:false,value:{x:800,y:800}},{id:'customCurve',type:'array',minItems:250,maxItems:250,items:{type:'number',min:0.1,max:3.4028234663852886e38},writable:false,value:Array(250).fill(1)}],unavailable:[],message:'OFFLINE'};
  const requests=[];
  const server=http.createServer((req,res)=>{
    requests.push(req.method);
    res.setHeader('X-Razer-Companion-Backend','rust'); res.setHeader('X-Razer-Companion-Writes','0');
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify(req.url==='/api/pair'?{token:'a'.repeat(64)}:state));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    await promisify(execFile)(powershell,['-NoProfile','-NonInteractive','-File','tests/support/hardware-gates-check.ps1','-Scenario','date','-TestEndpoint',`http://127.0.0.1:${server.address().port}`],{cwd:root,windowsHide:true,timeout:10000});
    assert.deepEqual(requests,['GET','GET','GET','GET']);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});
