'use strict';
const { test }=require('node:test');
const assert=require('node:assert/strict');
const {allowedImage,allowedBytes,imageForProduct}=require('../services/catalogImage');
const PNG=Buffer.concat([
  Buffer.from([137,80,78,71,13,10,26,10]),
  Buffer.alloc(170,0)
]);
test('image proxy accepts only published HTTPS DropBuy image URLs',()=>{
  assert.equal(allowedImage('http://r6i.pen.dropbuy.vn/md/s-1/img.png'),null);
  assert.equal(allowedImage('https://example.com/md/s-1/img.png'),null);
  assert.equal(allowedImage('https://r6i.pen.dropbuy.vn.evil.com/md/img.png'),null);
  assert.equal(allowedImage('https://r6i.pen.dropbuy.vn/redirect?id=1'),null);
  assert.equal(allowedImage('file:///etc/passwd'),null);
  assert.ok(allowedImage('https://r6i.pen.dropbuy.vn/md/s-1/p-101/photo_256x256.png'));
});
test('image magic bytes checked before responding',()=>{
  assert.equal(allowedBytes(PNG,'image/png'),true);
  assert.equal(allowedBytes(Buffer.alloc(170),'image/png'),false);
  assert.equal(allowedBytes(PNG,'image/jpeg'),false);
});
test('concurrent requests coalesce, expose only image bytes and are cached',async()=>{
  const saved=global.fetch;
  let calls=0;
  try {
    global.fetch=async(url,opts)=>{
      calls++;
      assert.match(url, /^https:\/\/r6i\.pen\.dropbuy\.vn\/md\//);
      assert.equal(opts.headers.cookie,undefined);
      assert.equal(opts.headers.authorization,undefined);
      return new Response(PNG,{status:200,headers:{'content-type':'image/png'}});
    };
    const item={id:99001,image:'https://r6i.pen.dropbuy.vn/md/s-1/p-99001/photo.png'};
    const data=await Promise.all([imageForProduct(item),imageForProduct(item),imageForProduct(item)]);
    assert.equal(calls,1,'request should be deduplicated');
    assert.equal(data[0].mime,'image/png');
    assert.deepEqual(data[0].buffer,PNG);
    const repeat=await imageForProduct(item);
    assert.equal(calls,1,'result should come from memory cache');
    assert.deepEqual(repeat.buffer,PNG);
  } finally {global.fetch=saved;}
});
