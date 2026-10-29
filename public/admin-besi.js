'use strict';
/* No tokens, supplier URLs or credentials are stored in the browser. */
(() => {
  const $ = id => document.getElementById(id);
  const money = value => new Intl.NumberFormat('vi-VN').format(Number(value||0))+' đ';
  const message = (text,fail=false) => {
    const el=$('message');el.hidden=false;el.textContent=text;
    el.classList.toggle('error',fail);
  };
  const request=async(url,method='GET',data)=>{
    const res=await fetch(url,{method,credentials:'same-origin',
      headers:data===undefined?{}:{'Content-Type':'application/json'},
      body:data===undefined?undefined:JSON.stringify(data)});
    const json=await res.json().catch(()=>({}));
    if(!res.ok||!json.success){
      if(res.status===401)throw Error('Cần đăng nhập quản trị trước. Mở /admin.html và đăng nhập.');
      throw Error(json.error||'Không thể kết nối server');
    }
    return json;
  };
  function cell(row,value,bold=false){
    const e=document.createElement('td'),t=document.createElement(bold?'strong':'span');
    t.textContent=String(value??'');e.append(t);row.append(e);return e;
  }
  function empty(tbody,columns,text){
    tbody.replaceChildren();
    const tr=document.createElement('tr'),td=document.createElement('td');
    td.colSpan=columns;td.textContent=text;tr.append(td);tbody.append(tr);
  }
  let policy={};
  // Human-in-the-loop attribute verification: no AI/regex suggestion is
  // promoted into a verified facet without explicit administrator approval.
  let reviewData=null;
  const fields={connector:'besiReviewConnector',length:'besiReviewLength',
    power:'besiReviewPower',color:'besiReviewColor'};
  function showReviewVariant(){
    if(!reviewData)return;
    const v=reviewData.variations.find(x=>String(x.id)===String($('besiReviewVariant').value));
    if(!v)return;
    const data=v.verified||v.proposed||{};
    for(const [key,id] of Object.entries(fields))$(id).value=data[key]==null?'':String(data[key]);
    $('besiReviewConfirm').checked=false;
    $('besiReviewAdvice').textContent=v.verified
      ?'Thông số này đã được xác minh. Có thể sửa sau khi đối chiếu thực tế.'
      :'Đây chỉ là gợi ý tự động từ tên hàng, chưa xác minh. Kiểm tra nhãn hoặc thông tin phân loại trước khi lưu.';
  }
  async function openReview(id){
    const response=await request('/api/admin/besi/spec-review/'+encodeURIComponent(id));
    reviewData=response;
    $('besiReviewId').value=response.product.id;
    $('besiReviewTitle').textContent=response.product.name;
    const select=$('besiReviewVariant');
    select.replaceChildren();
    for(const v of response.variations){
      const opt=document.createElement('option');
      opt.value=v.id;
      opt.textContent=(v.name||'Thông số sản phẩm')+(v.verified?' ✓ Đã xác minh':'')
        +(v.in_stock?'':' · Hết hàng');
      select.append(opt);
    }
    showReviewVariant();
    $('besiSpecEditor').hidden=false;
    $('besiSpecEditor').scrollIntoView({behavior:'smooth',block:'center'});
  }
  $('besiReviewVariant')?.addEventListener('change',showReviewVariant);
  $('besiReviewClose')?.addEventListener('click',()=>{$('besiSpecEditor').hidden=true;});
  $('besiReviewForm')?.addEventListener('submit',event=>{
    event.preventDefault();
    submit(event.currentTarget,async()=>{
      if(!$('besiReviewConfirm').checked)throw Error('Cần xác nhận thông số đã được kiểm tra thực tế.');
      const productId=Number($('besiReviewId').value);
      const input={productId,variantId:$('besiReviewVariant').value,
        confirmed:true,connector:$('besiReviewConnector').value,
        length:$('besiReviewLength').value||null,
        power:$('besiReviewPower').value||null,
        color:$('besiReviewColor').value||null};
      if(!confirm('Lưu thông số chuẩn của đúng phân loại? Việc này sẽ thay đổi kết quả lọc sản phẩm.'))return;
      await request('/api/admin/besi/spec-review/'+productId,'PUT',input);
      message('Đã xác minh thuộc tính. Chỉ mục tìm kiếm sẽ cập nhật ngay.');
      await openReview(productId);await refreshCoverage(1);
    });
  });
  $('besiReviewUndo')?.addEventListener('click',async()=>{
    if(!reviewData)return;
    const id=Number($('besiReviewId').value),variantId=$('besiReviewVariant').value;
    if(!confirm('Hủy xác minh và trả về nhận diện từ tên sản phẩm?'))return;
    try{
      await request('/api/admin/besi/spec-review/'+id+'?'+new URLSearchParams({variantId}),'DELETE');
      message('Đã hủy xác minh thông số');
      await openReview(id);await refreshCoverage(1);
    }catch(e){message(e.message,true);}
  });

  let coveragePage=0,coveragePages=1,coverageBusy=false;
  async function refreshCoverage(page=1){
    if(coverageBusy)return;
    coverageBusy=true;
    const more=$('besiSpecReviewMore');more.disabled=true;
    try{
      const report=await request('/api/admin/besi/spec-coverage?page='+page);
      $('specCableTotal').textContent=Number(report.cableProducts||0).toLocaleString('vi-VN');
      $('specIndexedTotal').textContent=Number(report.indexedVariations||0).toLocaleString('vi-VN');
      $('specCoverageCount').textContent=Number(report.needsReview||0).toLocaleString('vi-VN');
      const tbody=$('specCoverageRows');
      if(page===1)tbody.replaceChildren();
      if(!report.review?.length&&page===1)
        empty(tbody,4,'Chưa có sản phẩm nào cần kiểm tra hoặc danh mục chưa có cáp sạc.');
      for(const item of report.review||[]){
        const tr=document.createElement('tr');
        cell(tr,item.id);cell(tr,item.name,true);
        cell(tr,item.reason==='unknown_connector'?'Chưa xác định rõ đầu kết nối':'Thiếu chiều dài, công suất hoặc màu');
        const action=cell(tr,'');
        const button=document.createElement('button');
        button.type='button';button.className='secondary';button.textContent='Kiểm duyệt';
        button.addEventListener('click',()=>openReview(item.id).catch(e=>message(e.message,true)));
        action.append(button);tbody.append(tr);
      }
      coveragePage=Number(report.page)||page;
      coveragePages=Number(report.totalPages)||1;
      more.hidden=coveragePage>=coveragePages;
    }finally{coverageBusy=false;more.disabled=false;}
  }
  async function refresh(){
    const [over,catalog]=await Promise.all([
      request('/api/admin/besi/overview'),request('/api/admin/besi/catalog')
    ]);
    const s=over.data;policy=s.policy||{};
    $('statSuppliers').textContent=s.suppliers.length;
    $('statActive').textContent=s.suppliers.filter(x=>x.active&&x.verified).length;
    $('statOffers').textContent=s.offerCount;
    $('statCatalog').textContent=s.canonicalProductCount;
    for(const key of ['markupPercent','feePercent','reservePercent','marginFloorPercent'])
      $(key).value=String(policy[key]??0);
    const tbody=$('suppliersRows');tbody.replaceChildren();
    if(!s.suppliers.length)empty(tbody,4,'Chưa có đối tác. Tạo đối tác đầu tiên ở biểu mẫu phía trên.');
    for(const supplier of s.suppliers){
      const tr=document.createElement('tr');
      const name=cell(tr,supplier.displayName,true),info=document.createElement('small');
      info.textContent=supplier.legalName+' · '+supplier.id;name.append(info);
      cell(tr,supplier.region||'Chưa cập nhật');
      const status=cell(tr,'');
      const tag=document.createElement('span');tag.className='status'+(supplier.active&&supplier.verified?' ready':'');
      tag.textContent=supplier.active&&supplier.verified?'Đang kinh doanh':supplier.verified?'Đã xác minh · Tạm dừng':'Chưa xác minh';
      status.append(tag);
      const action=cell(tr,'');
      const btn=document.createElement('button');btn.type='button';btn.className='secondary';
      btn.textContent=supplier.active?'Tạm dừng':supplier.verified?'Kích hoạt':'Xác minh & bật';
      btn.addEventListener('click',async()=>{
        const changes=supplier.active?{active:false}:supplier.verified?{active:true}:{verified:true,active:true};
        if(!confirm('Xác nhận thay đổi trạng thái đối tác?'))return;
        try{
          await request('/api/admin/besi/suppliers/'+encodeURIComponent(supplier.id),'PATCH',changes);
          message('Đã cập nhật đối tác');await refresh();
        }catch(e){message(e.message,true);}
      });
      action.append(btn);tbody.append(tr);
    }
    const select=$('supplierSelect'),previous=select.value;
    select.replaceChildren();
    for(const supplier of s.suppliers){
      const option=document.createElement('option');
      option.value=supplier.id;option.textContent=supplier.displayName+' ('+supplier.id+')';
      select.append(option);
    }
    if(s.suppliers.some(x=>x.id===previous))select.value=previous;
    const catalogRows=$('catalogRows');catalogRows.replaceChildren();
    if(!catalog.data.length)empty(catalogRows,5,'Chưa có mặt hàng: hãy xác minh đối tác và nhập SKU.');
    for(const product of catalog.data){
      const tr=document.createElement('tr');cell(tr,product.id);
      cell(tr,product.name,true);cell(tr,money(product.price));
      cell(tr,(product.tiers.find(t=>t.minQty===5)?.price==null?'Chưa đủ tồn':money(product.tiers.find(t=>t.minQty===5).price)));
      cell(tr,(product.tiers.find(t=>t.minQty===20)?.price==null?'Chưa đủ tồn':money(product.tiers.find(t=>t.minQty===20).price)));
      catalogRows.append(tr);
    }
  }
  async function submit(form,work){
    const button=form.querySelector('button[type=submit]');
    if(button)button.disabled=true;
    try{await work();}catch(e){message(e.message,true);}
    finally{if(button)button.disabled=false;}
  }
  $('supplierForm').addEventListener('submit',event=>{
    event.preventDefault();
    submit(event.currentTarget,async()=>{
      const f=new FormData(event.currentTarget);
      const input=Object.fromEntries(f.entries());
      input.shippingFee=Number(input.shippingFee||0);
      input.leadDays=Number(input.leadDays||2);
      await request('/api/admin/besi/suppliers','POST',input);
      event.currentTarget.reset();message('Đã tạo đối tác ở trạng thái chờ xác minh');await refresh();
    });
  });
  $('feedForm').addEventListener('submit',event=>{
    event.preventDefault();submit(event.currentTarget,async()=>{
      const supplierId=$('supplierSelect').value;
      if(!supplierId)throw Error('Hãy tạo một đối tác trước');
      const items=JSON.parse($('offerJson').value);
      if(!Array.isArray(items))throw Error('Danh sách SKU phải là mảng JSON');
      const result=await request('/api/admin/besi/feeds/'+encodeURIComponent(supplierId),'POST',{items});
      message('Nhập thành công '+result.data.received+' SKU: thêm '+result.data.created+' · cập nhật '+result.data.updated);
      await refresh();
    });
  });
  $('pricingForm').addEventListener('submit',event=>{
    event.preventDefault();submit(event.currentTarget,async()=>{
      const changes={...policy};
      for(const key of ['markupPercent','feePercent','reservePercent','marginFloorPercent'])
        changes[key]=Number($(key).value);
      await request('/api/admin/besi/pricing','PUT',changes);
      message('Đã lưu chính sách giá');await refresh();
    });
  });
  $('allocationForm').addEventListener('submit',event=>{
    event.preventDefault();submit(event.currentTarget,async()=>{
      if(!confirm('Tạo bản nháp phân bổ? Chưa có đơn hàng thật nào được gửi đi.'))return;
      const items=JSON.parse($('allocationJson').value);
      const result=await request('/api/admin/besi/allocate','POST',{items});
      $('allocationResult').hidden=false;
      $('allocationResult').textContent=JSON.stringify(result.data,null,2);
      message('Đã lập phương án chia đơn, trạng thái DRAFT_REVIEW');
      await refresh();
    });
  });
  refresh().catch(e=>message(e.message,true));
  $('besiSpecReviewMore')?.addEventListener('click',()=>{
    refreshCoverage(coveragePage+1).catch(e=>message('Lỗi xem thêm thông số: '+e.message,true));
  });
  refreshCoverage().catch(e=>{
    empty($('specCoverageRows'),4,'Chưa tải được báo cáo: '+e.message);
  });
})();
