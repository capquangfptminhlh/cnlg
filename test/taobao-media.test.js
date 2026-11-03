'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const media=require('../services/taobaoApprovedMedia');
const taobao=require('../services/taobaoPublic');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
const png=Buffer.from('89504e470d0a1a0a0000000d4948445200000001','hex');
const jpeg=Buffer.from('ffd8ffe000104a46494600010100000100','hex');
const webp=Buffer.from('52494646080000005745425056503820','hex');

test('Only recognized JPEG, PNG and WebP binary headers with matching MIME are accepted',()=>{
  assert.equal(media.extension(png,'image/png'),'.png');
  assert.equal(media.extension(jpeg,'image/jpeg'),'.jpg');
  assert.equal(media.extension(webp,'image/webp'),'.webp');
  assert.throws(()=>media.extension(png,'image/jpeg'),/JPEG|PNG|WebP/);
  assert.throws(()=>media.extension(Buffer.from('<svg onload="alert(1)"></svg>'),'image/svg+xml'),/JPEG|PNG|WebP/);
  assert.throws(()=>media.extension(Buffer.alloc(media.MAX_BYTES+1),'image/png'),/3 MB/);
});
test('Licensed product photo saved with content-hash name, safe path, idempotent writes',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'taobao-approved-photo-'));
  try{
    const a=media.saveImage(png,'image/png',{root:dir});
    const b=media.saveImage(png,'image/png',{root:dir});
    assert.deepEqual(a,b);
    assert.match(a.image,/^\/images\/taobao\/[a-f0-9]{64}\.png$/);
    const saved=fs.readFileSync(path.join(dir,path.basename(a.image)));
    assert.deepEqual(saved,png);
    assert.equal(a.bytes,png.length);
    assert.equal(fs.readdirSync(dir).length,1);
    const approved={id:'123456789012',title_vi:'Cáp sạc USB-C',category_vi:'Phụ kiện',
      options_zh:[],options_vi:[],translation_status:'translated',
      preview_approved:true,rights_verified:true,published:true,purchasable:false,
      besi_image:a.image};
    const catalog=taobao.getPublicCatalog([approved],{});
    assert.equal(catalog.total,1);
    assert.equal(catalog.data[0].image,a.image);
    assert.equal(catalog.data[0].can_order,false);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('Taobao media endpoint requires admin, rate limit, rights attestation and a raw image body',()=>{
  const server=read('server.js');
  assert.match(server,/app\.post\('\/api\/admin\/taobao\/image',requireAdmin/);
  assert.match(server,/rateLimit\('taobao-admin-media',60e3,20\)/);
  assert.match(server,/x-taobao-rights-confirmed/);
  assert.match(server,/express\.raw\(\{type:\['image\/jpeg','image\/png','image\/webp'\],limit:'3mb'\}\)/);
  assert.doesNotMatch(server.slice(server.indexOf("app.post('/api/admin/taobao/image'"),
    server.indexOf("app.post('/api/admin/taobao/approve/:id'")),/http:\/\/|https:\/\/|fetch\(/);
  assert.match(read('.gitignore'),/public\/images\/taobao\/\*/);
});
test('Admin interface uploads licensed local image only after explicit rights confirmation',()=>{
  const html=read('public/admin-besi.html'),js=read('public/admin-besi.js');
  assert.match(html,/id="taobaoAdminMediaFile"/);
  assert.match(html,/id="taobaoAdminMediaUpload"/);
  assert.match(html,/id="taobaoAdminMediaPreview"/);
  assert.match(js,/taobaoAdminRights/);
  assert.match(js,/\/api\/admin\/taobao\/image/);
  assert.match(js,/x-taobao-rights-confirmed/);
  assert.match(js,/credentials:'same-origin'/);
  assert.match(js,/taobaoAdminImage/);
  assert.doesNotThrow(()=>new vm.Script(js,{filename:'admin-besi.js'}));
});
