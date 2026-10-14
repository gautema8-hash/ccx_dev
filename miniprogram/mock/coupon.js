/** 优惠券 Mock：新客券 / 满减券 / 锅底券 */
const COUPONS = [
  { id: 'cp1', name: '新客立减券', type: 'CASH', value: 500, threshold: 0, scope: '全场通用', expireAt: '2026-12-31', usable: true },
  { id: 'cp2', name: '满 50 减 10', type: 'CASH', value: 1000, threshold: 5000, scope: '全场通用（不含锅底）', expireAt: '2026-12-31', usable: true },
  { id: 'cp3', name: '锅底免费券', type: 'SOUP', value: 1800, threshold: 0, scope: '限锅底', expireAt: '2026-12-31', usable: true },
];

/** 计算某张券在当前订单金额下的实际抵扣（分） */
function calcDiscount(coupon, summary) {
  if (!coupon) return 0;
  const base = coupon.type === 'SOUP' ? summary.soupFee : summary.goodsAmount + summary.soupFee;
  if (summary.goodsAmount + summary.soupFee < coupon.threshold) return 0;
  return Math.min(coupon.value, base);
}

module.exports = { COUPONS, calcDiscount };
