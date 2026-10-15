/**
 * 加盟咨询
 * 全屏宣传海报 + 居中企业微信二维码。
 * 二维码与海报文案全部来自后台配置（/franchise），未配置时用纯 CSS 占位图兜底，
 * 「保存到相册」用离屏 canvas 2d 合成海报：渐变色底 + 文案 + 二维码 + 提示语。
 */
const chain = require('../../../services/chain');
const content = require('../../../services/content');
const { toast } = require('../../../utils/util');
const { toastError } = require('../../../utils/request');

/* 海报画布逻辑尺寸（px，非 rpx）：3:5 竖版，导出后清晰度足够朋友圈转发 */
const POSTER_W = 750;
const POSTER_H = 1180;

Page({
  data: {
    themeStyle: '',
    info: {
      title: '',
      subtitle: '',
      highlights: [],
      qrUrl: '',
      qrTip: '长按识别二维码，添加加盟顾问企业微信',
      consultPhone: '',
      wecomId: '',
    },
    saving: false,
  },

  onLoad() {
    chain.applyTheme(this);
    content
      .getFranchise()
      .then((info) => this.setData({ info: Object.assign({}, this.data.info, info || {}) }))
      .catch((e) => toastError(e, '加盟信息加载失败'));
  },

  /* ------------------------- 预览 ------------------------- */

  /** 二维码缩放预览（微信原生预览支持双指缩放与长按保存/识别） */
  previewQr() {
    const url = this.data.info.qrUrl;
    if (!url) {
      toast('二维码待商家配置，可先复制企微号添加');
      return;
    }
    wx.previewImage({ urls: [url], fail: () => toast('预览失败') });
  },

  copyWecom() {
    const id = this.data.info.wecomId;
    if (!id) return toast('暂未配置企微号');
    wx.setClipboardData({ data: id, success: () => toast('企微号已复制', 'success') });
  },

  callConsult() {
    const phone = this.data.info.consultPhone;
    if (!phone) return toast('暂未配置加盟热线');
    wx.makePhoneCall({ phoneNumber: phone, fail: () => {} });
  },

  /* ------------------------- 海报导出 ------------------------- */

  /** 预览海报：先合成图片，再走原生预览（可放大查看细节 / 长按转发） */
  previewPoster() {
    wx.showLoading({ title: '生成中', mask: true });
    this.buildPoster()
      .then((path) => {
        wx.hideLoading();
        wx.previewImage({ urls: [path], fail: () => toast('预览失败') });
      })
      .catch((e) => {
        wx.hideLoading();
        this.fallbackSave(e);
      });
  },

  savePoster() {
    if (this.data.saving) return;
    this.setData({ saving: true });
    wx.showLoading({ title: '生成中', mask: true });
    this.buildPoster()
      .then((path) => {
        wx.hideLoading();
        return this.saveToAlbum(path);
      })
      .catch((e) => {
        wx.hideLoading();
        this.fallbackSave(e);
      })
      .then(() => this.setData({ saving: false }));
  },

  saveToAlbum(filePath) {
    return new Promise((resolve) => {
      wx.saveImageToPhotosAlbum({
        filePath,
        success: () => {
          toast('已保存到相册', 'success');
          resolve(true);
        },
        fail: (e) => {
          const msg = String((e && e.errMsg) || '');
          if (msg.indexOf('auth deny') > -1 || msg.indexOf('authorize') > -1) {
            wx.showModal({
              title: '需要相册权限',
              content: '保存海报需要「保存到相册」权限，是否前往开启？',
              confirmColor: '#C62828',
              success: (r) => {
                if (r.confirm) wx.openSetting({ fail: () => {} });
              },
            });
          } else {
            toast('保存失败，可长按二维码保存');
          }
          resolve(false);
        },
      });
    });
  },

  /**
   * 画布合成失败时的兜底：不静默失败，直接引导用户长按二维码保存
   * （开发者工具与部分低端机对 canvas 2d 导出支持不稳定，这条路径必须能走通）
   */
  fallbackSave() {
    wx.showModal({
      title: '海报生成失败',
      content: '当前环境无法合成海报，可长按二维码直接保存或识别添加。',
      showCancel: false,
      confirmColor: '#C62828',
    });
  },

  /**
   * 用 canvas 2d 合成海报并导出临时文件
   * @returns {Promise<string>} 临时文件路径
   */
  buildPoster() {
    const info = this.data.info;
    return new Promise((resolve, reject) => {
      wx.createSelectorQuery()
        .in(this)
        .select('#poster')
        .fields({ node: true, size: true })
        .exec((res) => {
          const node = res && res[0] && res[0].node;
          if (!node) return reject('NO_CANVAS');

          const dpr = this.dpr();
          node.width = POSTER_W * dpr;
          node.height = POSTER_H * dpr;
          const ctx = node.getContext('2d');
          ctx.scale(dpr, dpr);

          const drawRest = (qrImg) => {
            try {
              this.paint(ctx, info, qrImg);
            } catch (err) {
              return reject(err);
            }
            wx.canvasToTempFilePath(
              {
                canvas: node,
                x: 0,
                y: 0,
                width: POSTER_W,
                height: POSTER_H,
                destWidth: POSTER_W * 2,
                destHeight: POSTER_H * 2,
                fileType: 'png',
                success: (r) => resolve(r.tempFilePath),
                fail: (err) => reject(err),
              },
              this
            );
          };

          /* 二维码是远程图，必须先下载成本地文件才能画进 canvas */
          if (!info.qrUrl) return drawRest(null);
          wx.getImageInfo({
            src: info.qrUrl,
            success: (r) => {
              const img = node.createImage();
              img.onload = () => drawRest(img);
              img.onerror = () => drawRest(null);
              img.src = r.path;
            },
            fail: () => drawRest(null),
          });
        });
    });
  },

  dpr() {
    try {
      const w = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
      return (w && w.pixelRatio) || 2;
    } catch (e) {
      return 2;
    }
  },

  /** 真正的绘制逻辑：底色 → 标题 → 亮点 → 二维码 → 提示语 */
  paint(ctx, info, qrImg) {
    const W = POSTER_W;
    const H = POSTER_H;

    /* 1. 背景：品牌红渐变 */
    const grad = ctx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, '#D32F2F');
    grad.addColorStop(0.55, '#B71C1C');
    grad.addColorStop(1, '#8E1414');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    /* 2. 顶部品牌行 */
    ctx.textAlign = 'center';
    ctx.fillStyle = '#FFE3B0';
    ctx.font = 'bold 40px sans-serif';
    ctx.fillText('老北京麻辣串串香', W / 2, 132);
    ctx.fillStyle = 'rgba(255,255,255,0.72)';
    ctx.font = '24px sans-serif';
    ctx.fillText('全 国 招 商 · 城 市 合 伙 人', W / 2, 176);

    /* 3. 主标题（过长自动折行） */
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 52px sans-serif';
    const titleLines = this.wrap(ctx, info.title || '加盟咨询', W - 120, 2);
    titleLines.forEach((line, i) => ctx.fillText(line, W / 2, 300 + i * 68));

    if (info.subtitle) {
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.font = '26px sans-serif';
      ctx.fillText(this.clip(ctx, info.subtitle, W - 140), W / 2, 300 + titleLines.length * 68 + 26);
    }

    /* 4. 亮点四宫格 */
    const hl = (info.highlights || []).slice(0, 4);
    if (hl.length) {
      const boxTop = 470;
      const boxW = (W - 80 - 20) / 2;
      const boxH = 120;
      hl.forEach((item, i) => {
        const col = i % 2;
        const row = Math.floor(i / 2);
        const x = 40 + col * (boxW + 20);
        const y = boxTop + row * (boxH + 20);
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        this.roundRect(ctx, x, y, boxW, boxH, 18);
        ctx.fill();
        ctx.textAlign = 'left';
        ctx.fillStyle = '#FFFFFF';
        ctx.font = 'bold 36px sans-serif';
        ctx.fillText(this.clip(ctx, item.value || '', boxW - 40), x + 24, y + 54);
        ctx.fillStyle = 'rgba(255,255,255,0.72)';
        ctx.font = '22px sans-serif';
        ctx.fillText(this.clip(ctx, item.label || '', boxW - 40), x + 24, y + 90);
        ctx.textAlign = 'center';
      });
    }

    /* 5. 二维码白卡 */
    const cardW = 480;
    const cardH = 480;
    const cardX = (W - cardW) / 2;
    const cardY = 790;
    ctx.fillStyle = '#FFFFFF';
    this.roundRect(ctx, cardX, cardY, cardW, cardH, 28);
    ctx.fill();

    const qrSize = 340;
    const qrX = (W - qrSize) / 2;
    const qrY = cardY + 46;
    if (qrImg) {
      ctx.drawImage(qrImg, qrX, qrY, qrSize, qrSize);
    } else {
      /* 占位图：三个定位角 + 文案，与页面上的 CSS 占位图视觉一致 */
      ctx.fillStyle = '#F5F5F7';
      this.roundRect(ctx, qrX, qrY, qrSize, qrSize, 16);
      ctx.fill();
      ctx.fillStyle = '#C62828';
      const s = 68;
      const pts = [[qrX + 26, qrY + 26], [qrX + qrSize - 26 - s, qrY + 26], [qrX + 26, qrY + qrSize - 26 - s]];
      pts.forEach((p) => {
        this.roundRect(ctx, p[0], p[1], s, s, 10);
        ctx.fill();
        ctx.fillStyle = '#FFFFFF';
        this.roundRect(ctx, p[0] + 18, p[1] + 18, s - 36, s - 36, 6);
        ctx.fill();
        ctx.fillStyle = '#C62828';
      });
      ctx.fillStyle = '#8A8A8E';
      ctx.font = '26px sans-serif';
      ctx.fillText('企业微信', W / 2, qrY + qrSize / 2 + 10);
    }

    ctx.fillStyle = '#1F1F1F';
    ctx.font = 'bold 28px sans-serif';
    ctx.fillText(this.clip(ctx, info.qrTip || '扫码添加加盟顾问', cardW - 60), W / 2, cardY + qrSize + 76);

    /* 6. 底部企微号与提示 */
    ctx.fillStyle = 'rgba(255,255,255,0.86)';
    ctx.font = '26px sans-serif';
    ctx.fillText('企微号：' + (info.wecomId || '—'), W / 2, cardY + cardH + 56);
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = '22px sans-serif';
    ctx.fillText('长按识别二维码 · 了解加盟政策与投资测算', W / 2, cardY + cardH + 96);
  },

  /* ---------------- canvas 小工具 ---------------- */

  roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  },

  /** 按像素宽度折行（canvas 没有 text-wrap，只能自己量） */
  wrap(ctx, text, maxWidth, maxLines) {
    const chars = String(text || '').split('');
    const lines = [];
    let line = '';
    for (let i = 0; i < chars.length; i++) {
      const test = line + chars[i];
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = chars[i];
        if (lines.length === maxLines - 1) break;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
    return lines.slice(0, maxLines);
  },

  /** 单行截断（超长补省略号） */
  clip(ctx, text, maxWidth) {
    let s = String(text || '');
    if (ctx.measureText(s).width <= maxWidth) return s;
    while (s.length && ctx.measureText(s + '…').width > maxWidth) s = s.slice(0, -1);
    return s + '…';
  },

  onShareAppMessage() {
    return { title: '老北京麻辣串串香 · 城市合伙人计划', path: '/packageUser/pages/franchise/franchise' };
  },
});
