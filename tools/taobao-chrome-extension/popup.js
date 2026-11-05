'use strict';
/* No Taobao credentials, cookies, DOM HTML, order contents or address sent to BESI. */
const $=id=>document.getElementById(id);
let scannedTabId=null,scannedAt=0;
const BASE='https://besi.com.vn';
const isTaobao=url=>{
  try{
    const u=new URL(url);
    return u.protocol==='https:'&&(u.hostname==='taobao.com'||u.hostname.endsWith('.taobao.com'));
  }catch{return false;}
};
function notify(text,fail=false,which='result'){
  const e=$(which);e.textContent=text;e.classList.toggle('error',fail);
  e.classList.toggle('success',!fail&&which==='result');
}
async function currentTaobaoTab(){
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  if(!tab||!isTaobao(tab.url))throw Error('Hãy mở và chọn tab checkout Taobao sau khi đã đăng nhập.');
  return tab;
}
function readVisibleFreight(){
  const host=location.hostname;
  if(!(host==='taobao.com'||host.endsWith('.taobao.com')))
    return {valid:false,reason:'Trang hiện tại không thuộc Taobao'};
  const checkoutHints=['confirm_order','buy','trade','checkout','order'];
  const pagePath=location.pathname.toLowerCase();
  const maybeCheckout=checkoutHints.some(x=>pagePath.includes(x));
  const labels=['跨境运费','国际运费','集运运费','运费总计','总运费','运输费用','运费','物流费用','配送费'];
  const nodes=document.querySelectorAll('span, label, strong, b, td, th, small, p, div');
  const candidates=[],seen=new Set();
  const priceRegex=/[￥¥]\s*([\d,]+(?:\.\d{1,2})?)|([\d,]+(?:\.\d{1,2})?)\s*元/g;
  for(let i=0;i<Math.min(nodes.length,9000);i++){
    const node=nodes[i];
    if(!node||!node.getBoundingClientRect)continue;
    const text=(node.textContent||'').trim();
    if(text.length<2||text.length>32||!labels.some(x=>text.includes(x)))continue;
    const rect=node.getBoundingClientRect();
    if(rect.width===0||rect.height===0)continue;
    for(const parent of [node.parentElement,node.parentElement?.parentElement]){
      if(!parent)continue;
      const nearby=(parent.innerText||parent.textContent||'').replace(/\s+/g,' ').trim().slice(0,200);
      if(nearby.length>180||!labels.some(x=>nearby.includes(x)))continue;
      priceRegex.lastIndex=0;
      const matches=[...nearby.matchAll(priceRegex)];
      if(matches.length!==1)continue;
      const amount=Number((matches[0][1]||matches[0][2]||'').replace(/,/g,''));
      if(!Number.isFinite(amount)||amount<0||amount>1000000)continue;
      const label=labels.find(x=>nearby.includes(x))||'运费';
      const unique=label+':'+amount;
      if(seen.has(unique))continue;
      seen.add(unique);
      candidates.push({label,amount,currency:'CNY'});
      if(candidates.length>=8)break;
    }
    if(candidates.length>=8)break;
  }
  // An account's login status cannot be reliably inferred from HTML:
  // operators must confirm the actual checkout shipping line themselves.
  const amounts=[...new Set(candidates.map(x=>x.amount))];
  return {valid:true,maybeCheckout,candidates,
    confident:maybeCheckout&&amounts.length===1&&candidates.length>0,
    amount:amounts.length===1?amounts[0]:null,
    currency:'CNY'};
}
$('openTaobao').addEventListener('click',()=>chrome.tabs.create({url:'https://www.taobao.com/'}));
$('scan').addEventListener('click',async()=>{
  try{
    const tab=await currentTaobaoTab();
    const result=await chrome.scripting.executeScript({
      target:{tabId:tab.id},func:readVisibleFreight
    });
    const scanned=result?.[0]?.result;
    if(!scanned?.valid)throw Error('Không đọc được checkout Taobao: '+(scanned?.reason||'không rõ'));
    scannedTabId=tab.id;scannedAt=Date.now();
    if(scanned.confident){
      $('amount').value=String(scanned.amount);$('currency').value='CNY';
      notify('Tìm thấy một mức phí có thể liên quan vận chuyển: ¥'+
        scanned.amount+'. Hãy kiểm tra đây là phí TRỌN GÓI giao về Việt Nam trước khi lưu.',false,'scanResult');
    }else{
      const msg=!scanned.maybeCheckout
        ?'Chưa xác nhận đây là trang checkout. Hãy mở bước Taobao báo phí ship.'
        :scanned.candidates.length
          ?'Có nhiều mục giá/ship khác nhau. Hãy xem kỹ và nhập phí trọn gói từ Taobao, không lấy giá sản phẩm hoặc chỉ ship TQ.'
          :'Chưa nhận dạng được phí ship hiển thị. Anh có thể nhập số tiền đã thấy trực tiếp trên trang checkout.';
      notify(msg,false,'scanResult');
    }
  }catch(e){scannedTabId=null;notify(e.message,true,'scanResult');}
});
$('send').addEventListener('click',async()=>{
  const button=$('send');
  try{
    const tab=await currentTaobaoTab();
    if(scannedTabId!==tab.id||Date.now()-scannedAt>5*60*1000)
      throw Error('Hãy bấm Đọc cước trên đúng tab Taobao hiện tại trước khi gửi.');
    if(!$('confirmed').checked)
      throw Error('Cần xác nhận đúng phí giao về Việt Nam của một sản phẩm.');
    const item_id=$('itemId').value.trim(),sku=$('sku').value.trim();
    if(!/^[0-9]{6,20}$/.test(item_id))throw Error('Mã sản phẩm Taobao không hợp lệ.');
    if(sku&&!/^[A-Za-z0-9_.:-]{1,80}$/.test(sku))throw Error('Mã SKU không hợp lệ.');
    const token=$('pairCode').value.trim();
    if(!/^[A-Za-z0-9_-]{32,100}$/.test(token))throw Error('Mã ghép nối BESI không hợp lệ.');
    const state=$('state').value,method=$('method').value;
    const amountValue=$('amount').value.trim();
    const amount=amountValue!==''?Number(amountValue):NaN;
    if(state==='quoted'&&(!Number.isFinite(amount)||amount<0))
      throw Error('Cần nhập số tiền phí ship được Taobao báo.');
    if(state==='quoted'&&method==='consolidated'&&!$('weighed').checked)
      throw Error('Gom hàng cần kho đã cân và chốt cước trước khi báo số tiền.');
    const payload={
      item_id,sku,region:$('region').value,method,quote_state:state,
      source:'taobao_checkout',confirmedFromCheckout:true,
      destination_country:'VN',quantity:1,
      shipping_amount:state==='quoted'?amount:null,
      currency:state==='quoted'?$('currency').value:null,
      covers:state==='quoted'?'door_to_door':null,
      weighed_at_warehouse:$('weighed').checked,
      free_shipping_confirmed:$('free').checked,
      checked_at:new Date().toISOString()
    };
    button.disabled=true;
    const response=await fetch(BASE+'/api/taobao/browser-quote',{
      method:'POST',credentials:'omit',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
      body:JSON.stringify(payload)
    });
    const data=await response.json().catch(()=>({}));
    if(!response.ok||data.success!==true)
      throw Error(data.error||'Không chuyển được cước Taobao về BESI.');
    $('pairCode').value='';scannedTabId=null;scannedAt=0;
    notify('Đã lưu cước tham khảo về BESI. Hết hạn sau 24 giờ. '+
      'Không tạo đơn hàng hoặc thanh toán.');
  }catch(e){notify(e.message,true);}
  finally{button.disabled=false;}
});
