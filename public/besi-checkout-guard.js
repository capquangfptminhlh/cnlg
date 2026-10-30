'use strict';
/**
 * Checkout payment readiness checks shared by the BESI browser and tests.
 * Final amount and payment eligibility are still validated in server.js.
 */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.BesiCheckoutGuard=api;
})(typeof globalThis!=='undefined'?globalThis:this,()=>{
  function evaluate(options,method,total,{loaded=true,empty=false,shippingStatus='ready'}={}){
    const amount=Number(total);
    if(!loaded||!options||!options.cod||!options.bank){
      return {allowed:false,reason:'unavailable',
        note:'Chưa tải được phương thức thanh toán. Vui lòng đóng và mở lại phần đặt hàng.'};
    }
    if(empty||!Number.isFinite(amount)||amount<0){
      return {allowed:false,reason:'invalid',
        note:'Giỏ hàng trống hoặc tổng tiền không hợp lệ.'};
    }
    if(shippingStatus!=='ready'){
      const notes={
        missing:'Vui lòng chọn tỉnh/thành và phường/xã để xác nhận tổng tiền bao gồm phí vận chuyển.',
        pending:'Đang tính phí vận chuyển. Vui lòng đợi trước khi đặt hàng.',
        error:'Chưa tính được phí vận chuyển. Bấm “Tính lại phí ship” để thử lại.'
      };
      return {allowed:false,reason:'shipping-'+shippingStatus,
        note:notes[shippingStatus]||notes.error};
    }
    const cod=options.cod.enabled===true;
    const bank=options.bank.enabled===true;
    if(!cod&&!bank){
      return {allowed:false,reason:'none',
        note:'Cửa hàng chưa có phương thức thanh toán khả dụng. Vui lòng liên hệ hỗ trợ.'};
    }
    if(method==='BANK'){
      return bank?{allowed:true,reason:'ok',note:''}:
        {allowed:false,reason:'bank-disabled',
          note:'Cửa hàng chưa bật chuyển khoản. Vui lòng chọn phương thức khác.'};
    }
    if(method!=='COD'||!cod){
      return {allowed:false,reason:'cod-disabled',
        note:'Phương thức thanh toán khi nhận hàng hiện không khả dụng.'};
    }
    const max=Number(options.cod.maxTotal);
    if(Number.isFinite(max)&&max>0&&amount>max){
      const cap=max.toLocaleString('vi-VN')+'đ';
      return {allowed:false,reason:'cod-limit',maxTotal:max,
        note:'Đơn hàng vượt mức COD '+cap+'. Hãy giảm số lượng hoặc liên hệ cửa hàng để được hỗ trợ.'};
    }
    return {allowed:true,reason:'ok',note:Number.isFinite(max)&&max>0
      ?'COD áp dụng cho đơn đến '+max.toLocaleString('vi-VN')+'đ.':'Thanh toán khi nhận hàng.'};
  }
  return {evaluate};
});
