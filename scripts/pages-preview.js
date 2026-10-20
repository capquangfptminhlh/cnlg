/* Safe static GitHub Pages demo shim.
   No real API calls, no real payments, no credentials, no private repository data.
   Runs BEFORE production app.js; all mock records are synthetic. */
(() => {
  'use strict';
  window.HM_DEMO_MODE = true;

  const definitions = [
    ['Cáp sạc USB-C bện dù',1,49000,'cable','#ffcab8'],
    ['Tai nghe Bluetooth gọn nhẹ',2,289000,'headphones','#cee2ff'],
    ['Ốp bảo vệ điện thoại',1,89000,'phone','#efdae9'],
    ['Đế sạc không dây',1,219000,'charger','#c7eedc'],
    ['Loa mini để bàn',2,349000,'speaker','#e7d7ff'],
    ['Đồng hồ thông minh',3,499000,'watch','#d4e4ff'],
    ['Quạt mini cầm tay',4,149000,'fan','#d3f2f4'],
    ['Đèn ngủ cảm ứng',4,179000,'lamp','#fce5b9'],
    ['Hub chuyển đổi USB-C',3,259000,'hub','#dde4ff'],
    ['Bàn phím không dây',5,399000,'keyboard','#e6e6f0'],
    ['Chuột Bluetooth công thái học',5,179000,'mouse','#ddf0fb'],
    ['Giá đỡ điện thoại',1,99000,'stand','#f9d9d0'],
    ['Bình nước giữ nhiệt',4,189000,'bottle','#d8f5ec'],
    ['Balo laptop nhẹ',5,449000,'bag','#e8d8ee'],
    ['Camera mini trong nhà',3,699000,'camera','#dbe4ff'],
    ['Đèn bàn LED chống chói',5,299000,'lamp','#fff1bb'],
    ['Tai nghe có dây',2,119000,'headphones','#e7d4fb'],
    ['Củ sạc nhanh đa cổng',1,239000,'charger','#f7e6cb'],
    ['Loa Bluetooth chống nước',2,599000,'speaker','#cff4eb'],
    ['Giá đỡ laptop gấp gọn',5,379000,'stand','#dceaff'],
    ['Pin sạc dự phòng',1,329000,'charger','#fce1dc'],
    ['Bộ vệ sinh thiết bị',5,79000,'hub','#ddf4e1'],
    ['Hộp đựng phụ kiện',1,69000,'bag','#f8e6cb'],
    ['Đèn LED trang trí',4,129000,'lamp','#fce4ef'],
    ['Bàn phím compact',5,659000,'keyboard','#d6ddfa'],
    ['Máy khuếch tán mini',4,389000,'fan','#d9f0fa'],
    ['Đế dựng máy tính bảng',3,189000,'stand','#e8ddfb'],
    ['Dây đeo đồng hồ',3,109000,'watch','#ffe1c9'],
    ['Giá đỡ ô tô',6,159000,'stand','#d3eafa'],
    ['Bộ sạc trên ô tô',6,199000,'charger','#f3e2c6'],
    ['Bộ chia cổng dữ liệu',3,269000,'hub','#f5dbe8'],
    ['Túi chống sốc laptop',5,299000,'bag','#dce8e2'],
    ['Đèn đọc sách USB',4,99000,'lamp','#fae7b3'],
    ['Micro thu âm mini',2,499000,'speaker','#d7d9fd'],
    ['Giá treo tai nghe',2,129000,'stand','#e1f0e8'],
    ['Miếng lót chuột',5,69000,'mouse','#f2e0f4']
  ];

  const labels = {
    1:'Phụ kiện điện thoại', 2:'Âm thanh & tai nghe', 3:'Thiết bị công nghệ',
    4:'Gia dụng tiện ích', 5:'Máy tính & văn phòng', 6:'Phụ kiện ô tô'
  };
  const shapes = {
    phone:'<rect x="116" y="53" width="88" height="166" rx="17" fill="#263447"/><rect x="124" y="68" width="72" height="131" rx="8" fill="#f8fbff"/><circle cx="160" cy="208" r="4" fill="#a6afbc"/>',
    headphones:'<path d="M91 169 V139a69 69 0 0 1 138 0v30" fill="none" stroke="#2d3b56" stroke-width="18" stroke-linecap="round"/><rect x="84" y="154" width="33" height="65" rx="12" fill="#334966"/><rect x="203" y="154" width="33" height="65" rx="12" fill="#334966"/>',
    cable:'<path d="M92 172c-29-75 85-117 108-43 18 63-78 45-55 104" fill="none" stroke="#3a4554" stroke-width="14" stroke-linecap="round"/><rect x="75" y="145" width="30" height="29" rx="5" fill="#465c75"/><rect x="137" y="222" width="30" height="25" rx="4" fill="#465c75"/>',
    speaker:'<rect x="94" y="75" width="132" height="161" rx="20" fill="#31394a"/><circle cx="160" cy="138" r="39" fill="#53667b"/><circle cx="160" cy="138" r="22" fill="#9eaebe"/><circle cx="160" cy="208" r="10" fill="#a6b6c5"/>',
    watch:'<rect x="139" y="36" width="42" height="245" rx="15" fill="#8494ab"/><rect x="103" y="103" width="114" height="113" rx="26" fill="#293646"/><rect x="113" y="113" width="94" height="93" rx="19" fill="#a9e6f4"/><path d="M160 132v29l21 16" stroke="#34445a" fill="none" stroke-width="8" stroke-linecap="round"/>',
    charger:'<rect x="98" y="96" width="123" height="121" rx="25" fill="#fafafa" stroke="#a8b2c0" stroke-width="5"/><rect x="124" y="77" width="13" height="22" rx="3" fill="#79889b"/><rect x="183" y="77" width="13" height="22" rx="3" fill="#79889b"/><rect x="130" y="144" width="63" height="19" rx="7" fill="#cad4dc"/>',
    fan:'<circle cx="160" cy="131" r="73" fill="#f9fcff" stroke="#7d9bb4" stroke-width="8"/><circle cx="160" cy="131" r="11" fill="#556f88"/><path d="M161 131c0-70-75-38-31 1-48 50 15 72 32 19 59 35 80-25 19-32z" fill="#a5cad5"/><rect x="150" y="206" width="20" height="47" rx="6" fill="#7d9bb4"/>',
    lamp:'<path d="M108 121q52-78 104 0l29 34H79z" fill="#e5b965"/><rect x="153" y="155" width="14" height="77" fill="#8e98ac"/><rect x="117" y="229" width="86" height="14" rx="7" fill="#64748b"/>',
    hub:'<rect x="72" y="115" width="180" height="97" rx="18" fill="#7184a5"/><rect x="93" y="149" width="39" height="22" rx="5" fill="#243248"/><rect x="151" y="149" width="39" height="22" rx="5" fill="#243248"/><rect x="208" y="149" width="25" height="22" rx="5" fill="#243248"/>',
    keyboard:'<rect x="51" y="121" width="220" height="111" rx="12" fill="#77899d"/><path d="M68 146H252M68 172H252M68 199H252" stroke="#ecf5fa" stroke-width="15" stroke-dasharray="16 6"/><rect x="109" y="212" width="103" height="9" rx="4" fill="#d8e7f2"/>',
    mouse:'<rect x="120" y="68" width="80" height="166" rx="40" fill="#c5d7e7" stroke="#566b82" stroke-width="6"/><path d="M160 71v60" stroke="#566b82" stroke-width="6"/><rect x="154" y="103" width="12" height="26" rx="6" fill="#566b82"/>',
    stand:'<rect x="101" y="208" width="120" height="18" rx="9" fill="#788ba0"/><path d="M133 204l34-109 31 11-34 101" fill="#c9d6e3" stroke="#8395a5" stroke-width="5"/>',
    bag:'<rect x="90" y="111" width="142" height="132" rx="16" fill="#9d82a6"/><path d="M123 116V92a38 38 0 0 1 75 0v25" stroke="#604c71" stroke-width="13" fill="none"/><rect x="112" y="167" width="99" height="17" rx="8" fill="#d9bbdf"/>',
    bottle:'<rect x="122" y="97" width="78" height="142" rx="22" fill="#62a7a1"/><rect x="137" y="66" width="47" height="36" rx="9" fill="#46847f"/><rect x="140" y="135" width="42" height="12" rx="6" fill="#e5faf4"/>',
    camera:'<rect x="88" y="122" width="144" height="97" rx="17" fill="#f3f7fa" stroke="#879aae" stroke-width="6"/><circle cx="160" cy="170" r="36" fill="#42596c"/><circle cx="160" cy="170" r="22" fill="#89abbc"/><rect x="115" y="98" width="46" height="23" rx="6" fill="#a0b0c0"/>'
  };
  function svgFor(item,index) {
    const bg=item[4];
    const art=shapes[item[3]]||shapes.hub;
    const svg='<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320" viewBox="0 0 320 320">'+
      '<rect width="320" height="320" fill="'+bg+'"/>'+
      '<circle cx="258" cy="60" r="86" fill="#fff" fill-opacity=".26"/>'+
      '<circle cx="40" cy="269" r="90" fill="#fff" fill-opacity=".21"/>'+art+
      '<rect x="83" y="268" width="154" height="26" rx="13" fill="#fff" fill-opacity=".64"/>'+
      '<text x="160" y="285" text-anchor="middle" font-size="13" font-family="Arial" fill="#45526b">SẢN PHẨM DEMO '+(index+1)+'</text></svg>';
    return 'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);
  }
  const products=definitions.map((item,index)=>({
    id:index+1,category_id:item[1],category_name:labels[item[1]],
    name:item[0]+' — hàng mô phỏng',price:item[2],
    original_price:null,discount_percent:0,
    slug:'san-pham-demo-'+(index+1),
    sku:'DEMO-'+String(index+1).padStart(3,'0'),
    image:svgFor(item,index),image_hd:svgFor(item,index),
    description:'<p>Sản phẩm minh họa để thử giao diện. Hình ảnh, giá và mô tả không phải dữ liệu bán hàng thật.</p>',
    warranty:'Chế độ mô phỏng',
    in_stock:index%11!==10,is_mall:false,variant_count:1,variation_id:index+1001,
    gallery:[{url:svgFor(item,index),thumb:svgFor(item,index)}],
    variants:[{id:index+1001,sku:'DEMO-'+(index+1),name:'Mặc định',is_default:true,
      in_stock:index%11!==10,price:item[2],original_price:null}],
    variation_options:[]
  }));
  const byId=new Map(products.map(p=>[p.id,p]));
  const categories=Object.entries(labels).map(([id,name])=>({
    id:Number(id),name,parent_id:null,product_count:products.filter(p=>p.category_id===Number(id)).length
  }));
  const provinces=[
    {name:'TP. Hồ Chí Minh',region_label:'Miền Nam'},
    {name:'Hà Nội',region_label:'Miền Bắc'},
    {name:'Đà Nẵng',region_label:'Miền Trung'},
    {name:'Cần Thơ',region_label:'Miền Nam'}
  ];
  const respond=(data,status=200)=>Promise.resolve(new Response(JSON.stringify(data),{
    status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}
  }));

  const realFetch=window.fetch.bind(window);
  window.fetch=function(input,init={}) {
    const raw=typeof input==='string'?input:input?.url;
    if(!raw)return realFetch(input,init);
    const url=new URL(raw,window.location.href);
    // Only mock the existing storefront API; never forward credentials or checkout requests.
    if(!url.pathname.startsWith('/api/'))return realFetch(input,init);
    const path=url.pathname,method=(init.method||input?.method||'GET').toUpperCase();
    if(path==='/api/categories')return respond({success:true,data:categories});
    if(path==='/api/realtime/status')return respond({success:true,data:{}});
    if(path==='/api/shipping/provinces')return respond({success:true,data:provinces});
    if(path==='/api/shipping/quote')return respond({success:true,data:{
      fee:0,detail:'Đây chỉ là mô phỏng giao diện, không phải báo giá vận chuyển.'
    }});
    if(path==='/api/products') {
      const param=url.searchParams;
      const needle=(param.get('search')||'').toLocaleLowerCase('vi');
      const category=param.get('category')||'all';
      const min=Number(param.get('minPrice'))||0;
      const max=Number(param.get('maxPrice'))||Infinity;
      const limit=Math.min(72,Math.max(1,Number(param.get('limit'))||24));
      const page=Math.max(1,Number(param.get('page'))||1);
      let list=products.filter(p=>(category==='all'||String(p.category_id)===category)&&
        p.price>=min&&p.price<=max&&(!needle||p.name.toLocaleLowerCase('vi').includes(needle)));
      switch(param.get('sort')){
        case 'price-asc':list.sort((a,b)=>a.price-b.price);break;
        case 'price-desc':list.sort((a,b)=>b.price-a.price);break;
        case 'name-asc':list.sort((a,b)=>a.name.localeCompare(b.name,'vi'));break;
      }
      const total=list.length;
      return respond({success:true,data:list.slice((page-1)*limit,page*limit),
        page,total,totalPages:Math.max(1,Math.ceil(total/limit))});
    }
    const idMatch=path.match(/^\/api\/products\/(\d+)$/);
    if(idMatch){
      const p=byId.get(Number(idMatch[1]));
      return respond(p?{success:true,data:p}:{success:false,error:'Sản phẩm demo không tồn tại'},p?200:404);
    }
    if(path==='/api/orders/checkout'||method==='POST') {
      return respond({success:false,error:'Đây là GitHub Pages DEMO. Không thể tạo đơn hàng hoặc nhận thanh toán.'},403);
    }
    return respond({success:false,error:'Tính năng này chỉ hoạt động trên server thật.'},404);
  };

  window.io=()=>({
    on(){return this;},
    emit(){return this;},
    off(){return this;},
    disconnect(){return this;}
  });

  function preventRealCheckout() {
    const submit=document.getElementById('submitOrderBtn');
    if(!submit)return;
    submit.setAttribute('type','button');
    submit.textContent='Bản demo — không tạo đơn hàng';
    submit.setAttribute('aria-label','Thanh toán bị tắt trong bản xem thử');
    submit.disabled=true;
    const hint=document.createElement('p');
    hint.className='demo-checkout-note';
    hint.textContent='CHỈ XEM THỬ — không nhập thông tin cá nhân và không chuyển tiền. Các sản phẩm, số tiền và phí vận chuyển là mô phỏng.';
    document.getElementById('checkoutForm')?.prepend(hint);
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',preventRealCheckout,{once:true});
  else preventRealCheckout();
})();
