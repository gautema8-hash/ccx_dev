/**
 * 地理位置计算（零依赖）
 *
 * 用 Haversine 公式算球面距离。为什么不上 PostGIS / MySQL 空间索引：
 *   单品牌门店量级是「几十到几百家」，全表取出在内存里算完全够用（毫秒级），
 *   而且能顺带做「同城优先 / 营业中优先」这类业务排序。
 *   门店超过 1000 家再换成 geohash 分桶或加空间索引，接口不用改。
 */

const EARTH_RADIUS_KM = 6371;

const toRad = (d) => (Number(d) * Math.PI) / 180;

/** 两点球面距离（公里），保留 2 位小数 */
function distanceKm(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(EARTH_RADIUS_KM * c * 100) / 100;
}

/** 距离展示文案 */
function distanceText(km) {
  if (km == null) return '';
  if (km < 1) return Math.round(km * 1000) + 'm';
  if (km < 100) return km.toFixed(1) + 'km';
  return Math.round(km) + 'km';
}

/** 校验经纬度是否合法（小程序 getLocation 可能拿到 0/0 或越界值） */
function validCoord(lat, lng) {
  const a = Number(lat);
  const b = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  if (a === 0 && b === 0) return false;
  if (a < -90 || a > 90 || b < -180 || b > 180) return false;
  return true;
}

/**
 * 是否为营业时间（按 "11:00 - 次日 02:00" / "11:00-02:00" 这类字符串判断）
 * 跨天营业（次日凌晨打烊）是餐饮常态，必须支持
 */
function isOpenNow(openTime, now) {
  const s = String(openTime || '');
  const m = s.match(/(\d{1,2}):(\d{2})\s*[-~至]\s*(?:次日)?\s*(\d{1,2}):(\d{2})/);
  if (!m) return true; // 没配营业时间就不做限制
  const d = now ? new Date(now) : new Date();
  const cur = d.getHours() * 60 + d.getMinutes();
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  if (start === end) return true; // 24 小时
  if (end > start) return cur >= start && cur <= end;
  // 跨天：当前时间在 [start, 24:00) 或 [00:00, end]
  return cur >= start || cur <= end;
}

module.exports = { distanceKm, distanceText, validCoord, isOpenNow, EARTH_RADIUS_KM };
