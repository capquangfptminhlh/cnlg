'use strict';
/**
 * Optional on-premises AI suggestions for difficult item names.
 * Local Ollama sees ONLY public product & variant display names (never
 * supplier URLs, credentials, feed records, costs, or SKU mapping).
 * Outputs are UNVERIFIED until an administrator confirms.
 */
const connectors=new Set(['c-lightning','a-lightning','lightning','c-c','a-c',null]);
const colors=new Set(['den','trang','xanh',null]);
const lengths=new Set([.5,1,1.2,1.5,2,3,null]);
const powers=new Set([20,30,60,100,null]);
function sanitizeCandidate(raw){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Gợi ý AI không hợp lệ');
  const connector=typeof raw.connector==='string'?raw.connector:null;
  const length=raw.length==null?null:Number(raw.length);
  const power=raw.power==null?null:Number(raw.power);
  const color=typeof raw.color==='string'?raw.color:null;
  if(!connectors.has(connector)||!lengths.has(length)
    ||!powers.has(power)||!colors.has(color))
    throw Error('Thông số AI vượt danh sách được phép');
  return {connector,length,power,color,verified:false,
    status:'AI đề xuất, phải kiểm tra thực tế trước khi duyệt'};
}
async function suggest({name,variantName='',fetchFn=fetch,model=process.env.BESI_SPEC_LOCAL_MODEL}){
  if(!model||!/^[a-z0-9][\w.:-]{0,70}$/i.test(String(model)))
    throw Object.assign(new Error('Chưa cấu hình AI chạy nội bộ'),{status:503});
  const label=String(name||'').replace(/[\r\n<>]/g,' ').slice(0,200);
  const variation=String(variantName||'').replace(/[\r\n<>]/g,' ').slice(0,110);
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),8000);
  try{
    const prompt=[
      'Bạn là bộ gợi ý thông số cáp sạc. Chỉ suy luận khi có bằng chứng rõ trong tên.',
      'Thiếu thông tin dùng null. Không tự đoán nếu một sản phẩm có nhiều loại chân cáp.',
      'Trả về JSON chỉ gồm connector (c-lightning,a-lightning,lightning,c-c,a-c hoặc null),',
      'length (0.5,1,1.2,1.5,2,3 hoặc null), power (20,30,60,100 hoặc null),',
      'color (den,trang,xanh hoặc null).',
      'Tên sản phẩm: '+label,'Tên biến thể: '+variation
    ].join('\n');
    // Fixed loopback address, not user-controlled or supplier-controlled URL.
    const result=await fetchFn('http://127.0.0.1:11434/api/generate',{
      method:'POST',signal:controller.signal,
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({model,stream:false,format:'json',
        options:{temperature:0,num_predict:160},prompt})
    });
    if(!result.ok)throw Error('Mô hình AI nội bộ chưa sẵn sàng');
    const json=await result.json();
    if(typeof json.response!=='string'||json.response.length>5000)
      throw Error('AI trả về dữ liệu không hợp lệ');
    return sanitizeCandidate(JSON.parse(json.response));
  }finally{clearTimeout(timer);}
}
module.exports={suggest,sanitizeCandidate};
