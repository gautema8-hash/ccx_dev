/**
 * 本地菜单数据（Mock）
 * 价格单位统一为「分」：300 = ¥3.00
 * 菜品 spicy=true 表示需要用户选择辣度，加购时弹出规格层
 */

const SHOP = {
  id: 'shop_001',
  name: '老北京麻辣串串香·簋街总店',
  logo: '🌶️',
  notice: '现串现涮 · 每日 11:00 开锅 · 桌边扫码即点',
  address: '北京市东城区东直门内大街 188 号',
  phone: '01088886666',
  openTime: '11:00 - 次日 02:00',
  rating: 4.8,
  perCapita: 68,
  tags: ['串串香', '麻辣', '夜宵'],
  /** 堂食桌号列表（真实业务由扫码参数 tableNo 带入） */
  tables: ['A01', 'A02', 'A03', 'B01', 'B02', 'B06', 'C08'],
};

/** 辣度（订单内每个串都可单独选，串串香的核心交互） */
const SPICY_OPTIONS = [
  { id: 'sp0', name: '不辣', color: '#8A8A8E' },
  { id: 'sp1', name: '微微辣', color: '#FF8F1F' },
  { id: 'sp2', name: '中辣', color: '#E64A19' },
  { id: 'sp3', name: '特辣', color: '#C62828' },
];

/** 锅底（订单级单选，必选） */
const SOUPS = [
  { id: 'sg1', name: '牛油红汤锅', price: 1200, emoji: '🍲', desc: '重庆牛油 + 汉源花椒，麻辣醇厚', recommended: true },
  { id: 'sg2', name: '番茄清汤锅', price: 1200, emoji: '🍅', desc: '番茄熬煮 4 小时，酸甜不辣，适合孩子' },
  { id: 'sg3', name: '鸳鸯锅', price: 1800, emoji: '🥘', desc: '一半红汤一半清汤，众口不再难调', recommended: true },
  { id: 'sg4', name: '清水锅', price: 800, emoji: '💧', desc: '矿泉水锅底，最大程度保留食材本味' },
];

/** 蘸料（订单级多选，免加价） */
const DIPS = [
  { id: 'dp1', name: '蒜泥香油碟', price: 0, emoji: '🧄' },
  { id: 'dp2', name: '干碟（辣椒面）', price: 0, emoji: '🌶️' },
  { id: 'dp3', name: '麻酱碟', price: 0, emoji: '🥜' },
  { id: 'dp4', name: '香辣豉油碟', price: 0, emoji: '🥢' },
];

const CATEGORIES = [
  { id: 'c_signature', name: '招牌必点', emoji: '🥇' },
  { id: 'c_meat', name: '串串 · 荤', emoji: '🥩' },
  { id: 'c_veg', name: '串串 · 素', emoji: '🥬' },
  { id: 'c_snack', name: '特色小吃', emoji: '🍢' },
  { id: 'c_staple', name: '主食', emoji: '🍜' },
  { id: 'c_drink', name: '饮品', emoji: '🥤' },
];

const DISHES = [
  /* ---------------- 招牌必点 ---------------- */
  { id: 'd101', categoryId: 'c_signature', name: '秘制麻辣牛肉串', emoji: '🥩', price: 300, unit: '串', spicy: true, sold: 12890, stock: 500, tags: ['招牌', '现串'], desc: '牛里脊切薄片，秘制腌料 6 小时，涮 8 秒即食' },
  { id: 'd102', categoryId: 'c_signature', name: '爽脆小郡肝', emoji: '🍡', price: 300, unit: '串', spicy: true, sold: 9820, stock: 400, tags: ['招牌'], desc: '鸡胗改刀成串，脆嫩弹牙' },
  { id: 'd103', categoryId: 'c_signature', name: '掌中宝', emoji: '🍗', price: 300, unit: '串', spicy: true, sold: 7610, stock: 300, tags: ['热销'], desc: '鸡爪掌心软骨，一口一个爆汁' },
  { id: 'd104', categoryId: 'c_signature', name: '脆皮小香肠', emoji: '🌭', price: 200, unit: '串', spicy: false, sold: 6540, stock: 300, tags: ['不辣可选'], desc: '广式腊肠风，涮后外皮爆开' },
  { id: 'd105', categoryId: 'c_signature', name: '香菜牛肉卷', emoji: '🌿', price: 300, unit: '串', spicy: true, sold: 5980, stock: 300, tags: ['招牌'], desc: '整根香菜裹进牛肉，香到上头' },

  /* ---------------- 串串 · 荤 ---------------- */
  { id: 'd201', categoryId: 'c_meat', name: '泡椒牛肉串', emoji: '🥩', price: 300, unit: '串', spicy: true, sold: 4320, stock: 400, tags: ['重口'], desc: '泡椒夹心，辣度层层递进' },
  { id: 'd202', categoryId: 'c_meat', name: '芹菜牛肉串', emoji: '🌿', price: 300, unit: '串', spicy: true, sold: 3870, stock: 400, tags: ['清爽'], desc: '芹菜解腻，越吃越顺口' },
  { id: 'd203', categoryId: 'c_meat', name: '鹌鹑蛋', emoji: '🥚', price: 200, unit: '串', spicy: true, sold: 5120, stock: 500, tags: ['经典'], desc: '油炸后再涮，吸汁力极强' },
  { id: 'd204', categoryId: 'c_meat', name: '午餐肉片', emoji: '🥓', price: 250, unit: '串', spicy: true, sold: 3260, stock: 300, tags: [], desc: '厚切梅林，涮后有嚼劲' },
  { id: 'd205', categoryId: 'c_meat', name: '毛肚（大份）', emoji: '🥬', price: 400, unit: '串', spicy: true, sold: 2980, stock: 200, tags: ['限量'], desc: '七上八下，脆到出声' },
  { id: 'd206', categoryId: 'c_meat', name: '鸭血', emoji: '🍢', price: 200, unit: '串', spicy: true, sold: 2140, stock: 300, tags: [], desc: '嫩滑入味，红汤绝配' },
  { id: 'd207', categoryId: 'c_meat', name: '广式腊肠', emoji: '🌭', price: 300, unit: '串', spicy: true, sold: 1890, stock: 200, tags: [], desc: '甜辣交织，北派串串的隐藏款' },

  /* ---------------- 串串 · 素 ---------------- */
  { id: 'd301', categoryId: 'c_veg', name: '土豆片', emoji: '🥔', price: 150, unit: '串', spicy: true, sold: 8760, stock: 600, tags: ['必点'], desc: '切 3mm 薄片，涮 30 秒粉糯' },
  { id: 'd302', categoryId: 'c_veg', name: '藕片', emoji: '🍥', price: 150, unit: '串', spicy: true, sold: 7210, stock: 600, tags: ['必点'], desc: '脆藕吸辣，越辣越想吃' },
  { id: 'd303', categoryId: 'c_veg', name: '香菇', emoji: '🍄', price: 200, unit: '串', spicy: true, sold: 4650, stock: 400, tags: [], desc: '厚菇肉厚，自带鲜味' },
  { id: 'd304', categoryId: 'c_veg', name: '娃娃菜', emoji: '🥬', price: 120, unit: '串', spicy: true, sold: 6120, stock: 600, tags: ['解辣'], desc: '吸满红油汤汁，一口爆汁' },
  { id: 'd305', categoryId: 'c_veg', name: '千张', emoji: '🍢', price: 150, unit: '串', spicy: true, sold: 3980, stock: 500, tags: [], desc: '豆香浓，涮久不烂' },
  { id: 'd306', categoryId: 'c_veg', name: '玉米小段', emoji: '🌽', price: 180, unit: '串', spicy: true, sold: 2760, stock: 300, tags: ['甜'], desc: '水果玉米，甜辣平衡' },
  { id: 'd307', categoryId: 'c_veg', name: '黑木耳', emoji: '🍄', price: 180, unit: '串', spicy: true, sold: 2430, stock: 300, tags: [], desc: '东北秋耳，脆爽弹牙' },

  /* ---------------- 特色小吃 ---------------- */
  { id: 'd401', categoryId: 'c_snack', name: '红糖冰粉', emoji: '🍧', price: 800, unit: '份', spicy: false, sold: 4320, stock: 200, tags: ['解辣神器'], desc: '手搓冰粉 + 老红糖 + 山楂花生碎' },
  { id: 'd402', categoryId: 'c_snack', name: '现炸小酥肉', emoji: '🍖', price: 1800, unit: '份', spicy: false, sold: 3120, stock: 150, tags: ['热销'], desc: '现裹现炸，椒盐 + 干碟双蘸' },
  { id: 'd403', categoryId: 'c_snack', name: '酸辣粉', emoji: '🍜', price: 1200, unit: '份', spicy: true, sold: 2340, stock: 150, tags: [], desc: '手工红薯粉，酸香打底' },
  { id: 'd404', categoryId: 'c_snack', name: '红糖糍粑', emoji: '🍡', price: 1000, unit: '份', spicy: false, sold: 1980, stock: 150, tags: [], desc: '外脆里糯，黄豆粉裹满' },

  /* ---------------- 主食 ---------------- */
  { id: 'd501', categoryId: 'c_staple', name: '手工宽面', emoji: '🍜', price: 500, unit: '份', spicy: false, sold: 2140, stock: 200, tags: [], desc: '涮完串串下面条，汤底一滴不浪费' },
  { id: 'd502', categoryId: 'c_staple', name: '蛋炒饭', emoji: '🍚', price: 1200, unit: '份', spicy: false, sold: 1760, stock: 150, tags: [], desc: '隔夜米现炒，粒粒分明' },
  { id: 'd503', categoryId: 'c_staple', name: '手工馄饨', emoji: '🥟', price: 1000, unit: '份', spicy: false, sold: 1320, stock: 150, tags: [], desc: '现包鲜肉馄饨，8 只装' },

  /* ---------------- 饮品 ---------------- */
  { id: 'd601', categoryId: 'c_drink', name: '冰镇酸梅汤', emoji: '🥤', price: 600, unit: '扎', spicy: false, sold: 5670, stock: 300, tags: ['解辣'], desc: '自熬乌梅 + 桂花，冰镇 4 小时' },
  { id: 'd602', categoryId: 'c_drink', name: '北冰洋汽水', emoji: '🧊', price: 800, unit: '瓶', spicy: false, sold: 4210, stock: 300, tags: ['京味'], desc: '老北京味道，配辣最对' },
  { id: 'd603', categoryId: 'c_drink', name: '唯怡豆奶', emoji: '🥛', price: 600, unit: '瓶', spicy: false, sold: 3120, stock: 300, tags: [], desc: '串串香官方 CP，解辣首选' },
  { id: 'd604', categoryId: 'c_drink', name: '鲜榨西瓜汁', emoji: '🍉', price: 1200, unit: '杯', spicy: false, sold: 1890, stock: 200, tags: [], desc: '现榨不加糖，半杯都是果肉' },
];

module.exports = { SHOP, SPICY_OPTIONS, SOUPS, DIPS, CATEGORIES, DISHES };
