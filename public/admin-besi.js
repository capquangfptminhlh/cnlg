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
  $('besiReviewAskAI')?.addEventListener('click',async()=>{
    const button=$('besiReviewAskAI'),id=Number($('besiReviewId').value);
    if(!reviewData||!id)return;
    button.disabled=true;
    try{
      const result=await request('/api/admin/besi/spec-ai-suggest/'+id,'POST',
        {variantId:$('besiReviewVariant').value});
      for(const [key,field] of Object.entries(fields)){
        // AI never overwrites a field with null or a saved human verification.
        const current=reviewData.variations.find(x=>String(x.id)===String($('besiReviewVariant').value));
        if(current?.verified)continue;
        if(result.data[key]!==null&&result.data[key]!==undefined)$(field).value=String(result.data[key]);
      }
      $('besiReviewConfirm').checked=false;
      $('besiReviewAdvice').textContent='AI chỉ đưa ra gợi ý, chưa xác minh. Hãy đối chiếu thông số trên phân loại thực tế trước khi lưu.';
      message('Đã nhận gợi ý AI nội bộ; chưa lưu bất kỳ thông số nào.');
    }catch(e){message(e.message,true);}
    finally{button.disabled=false;}
  });
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

  // Taobao operations: every API below requires the existing BESI admin session.
  // Only textContent is used for IDs, translated names and error text.
  const taobaoQueue={page:1,limit:20,q:'',view:'review',total:0};
  async function refreshTaobaoStatus(){
    const response=await request('/api/admin/taobao/status');
    const s=response.data,counts=s.counts||{};
    $('taobaoAdminStaged').textContent=String(counts.staged??0);
    $('taobaoAdminApproved').textContent=String(counts.approved_previews??0);
    $('taobaoAdminPriced').textContent=String(counts.price_quotes_ready??0);
    $('taobaoAdminShipped').textContent=String(counts.shipping_quotes_ready??0);
    $('taobaoAdminFxStatus').textContent=s.fx?.ready
      ?'FX CNY/VND: '+Math.round(s.fx.rate_vnd_per_cny).toLocaleString('vi-VN')+' đ · '+String(s.fx.as_of).slice(0,10)
      :'Chưa có tỷ giá CNY/VND còn hiệu lực';
    $('taobaoAdminFreightStatus').textContent=s.freight_tariff?.ready
      ?'Biểu phí còn hạn: '+String(s.freight_tariff.updated_at).slice(0,10)
      :'Chưa có biểu phí vận chuyển hợp lệ';
    $('taobaoAdminSyncStatus').textContent=s.manual_sync?.running
      ?'Đang đồng bộ danh mục…':s.staging_lock?.busy
        ?'Kho chờ đang được xử lý'
        :s.manual_sync?.last_error?'Lỗi: '+s.manual_sync.last_error
        :s.manual_sync?.finished_at?'Đã hoàn tất lượt đồng bộ':'Chưa chạy đồng bộ thủ công';
    $('taobaoAdminRunSync').disabled=!s.data_permission||!s.api_credentials_configured
      ||s.manual_sync?.running===true||s.staging_lock?.busy===true;
    return s;
  }
  async function refreshTaobaoQueue(){
    const params=new URLSearchParams({page:String(taobaoQueue.page),
      limit:String(taobaoQueue.limit),q:taobaoQueue.q,view:taobaoQueue.view});
    const response=await request('/api/admin/taobao/review?'+params);
    const data=response.data||{},rows=Array.isArray(data.rows)?data.rows:[];
    taobaoQueue.total=Number(data.total)||0;
    const tbody=$('taobaoAdminRows');tbody.replaceChildren();
    if(!rows.length)empty(tbody,5,'Không tìm thấy sản phẩm phù hợp ở trạng thái này.');
    for(const entry of rows){
      const tr=document.createElement('tr');
      cell(tr,entry.id);
      cell(tr,entry.title_vi||'Chưa có bản dịch',true);
      cell(tr,entry.category_vi||'Chưa phân loại');
      cell(tr,entry.preview_approved?'Đã duyệt':entry.translation_status==='translated'?'Chờ duyệt':'Chưa dịch xong');
      const action=cell(tr,''),button=document.createElement('button');
      button.type='button';button.className='secondary';
      button.textContent=entry.preview_approved?'Thu hồi':'Chọn để duyệt';
      button.disabled=!entry.preview_approved&&entry.translation_status!=='translated';
      button.addEventListener('click',async()=>{
        if(entry.preview_approved){
          if(!confirm('Thu hồi ngay sản phẩm khỏi tab Taobao?'))return;
          button.disabled=true;
          try{
            await request('/api/admin/taobao/revoke/'+encodeURIComponent(entry.id),'POST',{});
            message('Đã thu hồi preview Taobao; không ảnh hưởng hàng đang bán.');
            await Promise.all([refreshTaobaoStatus(),refreshTaobaoQueue()]);
          }catch(e){message(e.message,true);}
          finally{button.disabled=false;}
        }else{
          $('taobaoAdminReviewId').value=entry.id;
          $('taobaoAdminCategory').value=entry.category_vi||'';
          $('taobaoAdminImage').value='';
          $('taobaoAdminRights').checked=false;
          $('taobaoAdminTranslation').checked=false;
          $('taobaoAdminReviewForm').scrollIntoView({behavior:'smooth',block:'center'});
          message('Kiểm tra bản dịch, quyền sử dụng và hình ảnh trước khi duyệt.');
        }
      });
      action.append(button);tbody.append(tr);
    }
    const pages=Math.max(1,Math.ceil(taobaoQueue.total/taobaoQueue.limit));
    $('taobaoAdminPage').textContent='Trang '+taobaoQueue.page+'/'+pages+' · '+taobaoQueue.total+' kết quả';
    $('taobaoAdminPrev').disabled=taobaoQueue.page<=1;
    $('taobaoAdminNext').disabled=taobaoQueue.page>=pages;
  }
  async function refreshTaobao(){
    await Promise.all([refreshTaobaoStatus(),refreshTaobaoQueue()]);
  }
  $('taobaoAdminReload')?.addEventListener('click',()=>{
    refreshTaobao().catch(e=>message('Taobao: '+e.message,true));
  });
  $('taobaoAdminRefreshFx')?.addEventListener('click',async e=>{
    e.currentTarget.disabled=true;
    try{
      const result=await request('/api/admin/taobao/fx-refresh','POST',{});
      message('Đã cập nhật tỷ giá CNY/VND tham khảo: '+Math.round(result.data.rate_vnd_per_cny).toLocaleString('vi-VN')+' đ');
      await refreshTaobaoStatus();
    }catch(err){message(err.message,true);}
    finally{e.currentTarget.disabled=false;}
  });
  $('taobaoAdminRunSync')?.addEventListener('click',async e=>{
    if(!confirm('Đồng bộ dữ liệu qua API Taobao đã được cấp quyền? Không tự mở bán.'))return;
    e.currentTarget.disabled=true;
    try{
      await request('/api/admin/taobao/sync','POST',{});
      message('Đã khởi chạy đồng bộ dữ liệu Taobao vào kho chờ riêng.');
      await refreshTaobaoStatus();
    }catch(err){message(err.message,true);}
  });
  $('taobaoAdminFilterForm')?.addEventListener('submit',e=>{
    e.preventDefault();
    taobaoQueue.q=$('taobaoAdminQuery').value.trim().slice(0,80);
    taobaoQueue.view=$('taobaoAdminView').value;
    taobaoQueue.page=1;
    refreshTaobaoQueue().catch(error=>message(error.message,true));
  });
  $('taobaoAdminPrev')?.addEventListener('click',()=>{
    if(taobaoQueue.page<=1)return;
    taobaoQueue.page--;
    refreshTaobaoQueue().catch(error=>message(error.message,true));
  });
  $('taobaoAdminNext')?.addEventListener('click',()=>{
    if(taobaoQueue.page*taobaoQueue.limit>=taobaoQueue.total)return;
    taobaoQueue.page++;
    refreshTaobaoQueue().catch(error=>message(error.message,true));
  });
  $('taobaoAdminReviewForm')?.addEventListener('submit',e=>{
    e.preventDefault();
    submit(e.currentTarget,async()=>{
      const id=$('taobaoAdminReviewId').value.trim();
      if(!/^[0-9]{6,20}$/.test(id))throw Error('Mã Taobao không hợp lệ');
      if(!$('taobaoAdminRights').checked||!$('taobaoAdminTranslation').checked)
        throw Error('Cần xác nhận quyền dữ liệu và bản dịch đã được kiểm duyệt');
      await request('/api/admin/taobao/approve/'+encodeURIComponent(id),'POST',{
        rightsConfirmed:true,translationReviewed:true,
        category:$('taobaoAdminCategory').value.trim(),
        image:$('taobaoAdminImage').value.trim()
      });
      message('Đã duyệt preview Taobao; sản phẩm chưa được phép thanh toán.');
      e.currentTarget.reset();
      $('taobaoAdminMediaPreview').hidden=true;
      $('taobaoAdminMediaPreview').removeAttribute('src');
      await refreshTaobao();
    });
  });
  $('taobaoAdminShippingCheckForm')?.addEventListener('submit',event=>{
    event.preventDefault();
    submit(event.currentTarget,async()=>{
      if(!$('taobaoAdminShippingConfirm').checked)
        throw Error('Cần xác minh thông số kiện và cước ship nội địa TQ');
      const dimensions_cm={
        length:Number($('taobaoAdminShippingLength').value),
        width:Number($('taobaoAdminShippingWidth').value),
        height:Number($('taobaoAdminShippingHeight').value)
      };
      const data=await request('/api/admin/taobao/shipping-check','POST',{
        region:$('taobaoAdminShippingRegion').value,
        shipping_weight_kg:Number($('taobaoAdminShippingWeight').value),
        china_domestic_shipping_cny:Number($('taobaoAdminShippingChinaDomestic').value),
        dimensions_cm
      });
      const quote=data.data||{},output=$('taobaoAdminShippingResult');
      output.hidden=false;
      if(quote.status!=='estimate'){
        const causes={
          fx_missing_or_stale:'Chưa có tỷ giá CNY/VND hợp lệ.',
          shipping_tariff_missing:'Chưa cấu hình biểu phí vận chuyển còn hạn.',
          china_domestic_shipping_missing:'Chưa xác minh ship nội địa Trung Quốc.',
          shipping_weight_missing:'Thiếu cân nặng kiện.',
          dimensions_unverified:'Thiếu kích thước kiện hàng.'
        };
        output.textContent='CHƯA BÁO ĐƯỢC PHÍ SHIP: '+
          (causes[quote.reason]||'Thông tin vận chuyển chưa đủ hoặc chưa được xác minh.');
        return;
      }
      const fmt=v=>Math.round(Number(v||0)).toLocaleString('vi-VN')+' đ';
      output.textContent=[
        'KẾT QUẢ PHÍ SHIP THAM KHẢO · '+quote.region_name,
        'Ship nội địa Trung Quốc: '+fmt(quote.china_domestic_shipping_vnd),
        'Vận chuyển Trung Quốc → Việt Nam: '+fmt(quote.international_shipping_vnd),
        'Giao nội địa Việt Nam: '+fmt(quote.domestic_vn_shipping_vnd),
        'Phí xử lý: '+fmt(quote.handling_vnd),
        'Cân nặng tính cước: '+quote.billable_weight_kg+' kg',
        'TỔNG PHÍ SHIP DỰ KIẾN: '+fmt(quote.shipping_vnd),
        'Tỷ giá tham khảo: 1 CNY ≈ '+fmt(quote.rate_vnd_per_cny),
        'Biểu phí cập nhật: '+String(quote.shipping_tariff_as_of||'').slice(0,10),
        'Chưa gồm thuế, phí nhập khẩu và phụ phí phát sinh. Không phải báo giá chính thức.'
      ].join('\n');
    });
  });
  $('taobaoAdminTariffForm')?.addEventListener('submit',e=>{
    e.preventDefault();
    submit(e.currentTarget,async()=>{
      if(!$('taobaoAdminTariffConfirm').checked)
        throw Error('Cần xác nhận biểu phí từ đối tác vận chuyển');
      const tariff=JSON.parse($('taobaoAdminTariffJson').value);
      await request('/api/admin/taobao/tariff','POST',{tariff,confirmed:true});
      message('Đã lưu biểu phí thực tế cho Taobao, sẽ tự áp dụng vào báo giá preview.');
      $('taobaoAdminTariffConfirm').checked=false;
      await refreshTaobaoStatus();
    });
  });

  $('taobaoAdminMediaUpload')?.addEventListener('click',async e=>{
    const button=e.currentTarget;
    try{
      if(!$('taobaoAdminRights').checked)
        throw Error('Cần xác nhận quyền sử dụng ảnh trước khi tải lên');
      const file=$('taobaoAdminMediaFile').files?.[0];
      if(!file)throw Error('Chưa chọn ảnh JPEG, PNG hoặc WebP');
      if(!['image/jpeg','image/png','image/webp'].includes(file.type)
        ||file.size<16||file.size>3*1024*1024)
        throw Error('Chỉ nhận ảnh JPEG/PNG/WebP có kích thước tối đa 3 MB');
      button.disabled=true;
      const response=await fetch('/api/admin/taobao/image',{
        method:'POST',credentials:'same-origin',
        headers:{'Content-Type':file.type,'x-taobao-rights-confirmed':'1'},
        body:file
      });
      const result=await response.json().catch(()=>({}));
      if(!response.ok||result.success!==true)
        throw Error(result.error||'Không lưu được ảnh sản phẩm');
      const url=String(result.data?.image||'');
      if(!new RegExp('^/images/taobao/[a-f0-9]{64}[.](?:jpg|png|webp)$','i').test(url))
        throw Error('Đường dẫn ảnh BESI trả về không hợp lệ');
      $('taobaoAdminImage').value=url;
      const preview=$('taobaoAdminMediaPreview');
      preview.src=url;preview.hidden=false;
      message('Ảnh đã lưu vào kho BESI. Sản phẩm chỉ hiển thị sau khi được duyệt.');
    }catch(error){message(error.message,true);}
    finally{button.disabled=false;}
  });
  refreshTaobao().catch(error=>{
    empty($('taobaoAdminRows'),5,'Chưa tải được hệ thống Taobao: '+error.message);
  });

})();
