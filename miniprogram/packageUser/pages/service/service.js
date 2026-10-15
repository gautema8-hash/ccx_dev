const chain = require('../../../services/chain');
const serviceApi = require('../../../services/service');
const auth = require('../../../utils/auth');
const config = require('../../../utils/config');
const { toast, confirm, formatTime } = require('../../../utils/util');
const { toastError } = require('../../../utils/request');

const EMOJIS = [
  '😀', '😄', '😅', '😂', '😊', '😍', '🤤', '😋',
  '🤗', '🤔', '😐', '😴', '😭', '😤', '🥵', '🤯',
  '👍', '👌', '🙏', '👏', '💪', '🎉', '❤️', '🌶️',
  '🍢', '🍲', '🥤', '🧾', '📍', '⭐', '🔥', '💰',
];

/** 文件大小 → 可读文本（WXML 不能调函数，统一在 JS 里算好） */
function sizeText(n) {
  const b = Number(n) || 0;
  if (!b) return '';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1024 / 1024).toFixed(1) + ' MB';
}

Page({
  data: {
    themeStyle: '',
    avatarText: '我',
    /** 当前客服工单号（服务端会话标识，0 = 尚未建立） */
    ticketId: 0,
    messages: [],
    quickReplies: [],
    draft: '',
    showEmoji: false,
    panel: false,
    showQuick: true,
    recording: false,
    playingId: '',
    intoView: '',
    emojis: EMOJIS,
  },

  onLoad() {
    this.maxId = 0;
    this.seq = 0;
    const me = auth.localUser() || {};
    this.setData({ avatarText: Array.from(String(me.nickname || '我'))[0] || '我' });
    this.initRecorder();
    this.loadSession();
  },

  onShow() {
    chain.applyTheme(this);
    this.startPolling();
  },

  onHide() {
    this.stopPolling();
  },

  onUnload() {
    this.stopPolling();
    if (this.recTimer) clearTimeout(this.recTimer);
    if (this.recorder) {
      try {
        this.recorder.stop();
      } catch (e) {}
      this.recorder = null;
    }
    if (this.audio) {
      this.audio.destroy();
      this.audio = null;
    }
  },

  /* ============================ 取数与轮询 ============================ */

  loadSession() {
    const store = chain.currentStore();
    wx.showLoading({ title: '连接客服', mask: true });
    serviceApi
      .session(store ? store.id : '')
      .then((d) => {
        wx.hideLoading();
        const list = (d.messages || []).map((m) => this.decorate(m));
        this.maxId = list.length ? list[list.length - 1].id : 0;
        /* ticket.id 由服务端下发，页面持有它才能判断「会话是否真的建起来了」 */
        this.setData({
          ticketId: (d.ticket && d.ticket.id) || 0,
          messages: list,
          quickReplies: d.quickReplies || [],
        });
        this.scrollToBottom();
      })
      .catch((e) => {
        wx.hideLoading();
        toastError(e, '客服连接失败');
      });
  },

  startPolling() {
    this.stopPolling();
    this.timer = setInterval(() => {
      /* 录音过程中不拉取，避免提示音与录音冲突 */
      if (this.data.recording) return;
      serviceApi
        .pull(this.maxId)
        .then((d) => {
          const list = (d.list || []).map((m) => this.decorate(m));
          if (!list.length) return;
          this.maxId = Number(d.maxId) || this.maxId;
          this.setData({ messages: this.data.messages.concat(list) });
          this.scrollToBottom();
        })
        .catch(() => {});
    }, serviceApi.POLL_INTERVAL);
  },

  stopPolling() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  },

  decorate(m) {
    const meta = m.meta || {};
    return Object.assign({}, m, {
      meta: meta,
      key: 'm' + m.id,
      status: 'ok',
      sizeText: sizeText(meta.size),
      timeText: formatTime(m.createdAt, true),
    });
  },

  scrollToBottom() {
    const list = this.data.messages;
    if (!list.length) return;
    this.setData({ intoView: 'msg-' + list[list.length - 1].key });
  },

  /* ============================ 输入区 ============================ */

  onDraft(e) {
    this.setData({ draft: e.detail.value });
  },

  onInputFocus() {
    /* 聚焦时收起面板，避免键盘与面板互相顶 */
    this.setData({ showEmoji: false, panel: false, showQuick: false });
  },

  toggleEmoji() {
    this.setData({ showEmoji: !this.data.showEmoji, panel: false, showQuick: false });
  },

  togglePanel() {
    this.setData({ panel: !this.data.panel, showEmoji: false, showQuick: false });
  },

  onEmoji(e) {
    this.setData({ draft: (this.data.draft || '') + e.currentTarget.dataset.e });
  },

  onQuick(e) {
    this.setData({ draft: e.currentTarget.dataset.send || '', showQuick: false });
  },

  /* ============================ 发送（乐观 UI + 服务端替换） ============================ */

  onSendText() {
    const content = String(this.data.draft || '').trim();
    if (!content) return;
    this.setData({ draft: '', showEmoji: false, panel: false, showQuick: false });
    const key = this.pushLocal({ type: 'text', content: content, mediaUrl: '', meta: {} });
    this.doSend(key, { type: 'text', content: content });
  },

  /** 本地乐观消息：先上屏，再上传/发送 —— 用户不会盯着空屏等网络 */
  pushLocal(msg) {
    const key = 'local' + ++this.seq;
    const item = Object.assign(
      { id: key, key: key, sender: 'USER', status: 'sending', createdAt: Date.now(), content: '', mediaUrl: '', meta: {} },
      msg,
      { sizeText: sizeText(msg.meta && msg.meta.size), timeText: '发送中' }
    );
    this.setData({ messages: this.data.messages.concat([item]) });
    this.scrollToBottom();
    return key;
  },

  /** 媒体上传完成后，把本地临时路径换成服务端 URL（失败时也保留可看的内容） */
  patchLocal(key, patch) {
    this.setData({
      messages: this.data.messages.map((m) => (m.key === key ? Object.assign({}, m, patch) : m)),
    });
  },

  failLocal(key, msg) {
    this.patchLocal(key, { status: 'failed', timeText: '发送失败' });
    toast(msg || '发送失败');
  },

  /** 真正发送并替换为服务端消息（id/时间以服务端为准，避免与轮询结果重复） */
  doSend(key, payload) {
    serviceApi
      .send(payload)
      .then((d) => {
        const msg = d && d.message;
        if (!msg) return;
        this.maxId = Math.max(this.maxId, msg.id);
        let list = this.data.messages.map((m) =>
          m.key === key ? Object.assign(this.decorate(msg), { key: key }) : m
        );
        if (d.autoReply) {
          this.maxId = Math.max(this.maxId, d.autoReply.id);
          list = list.concat([this.decorate(d.autoReply)]);
        }
        this.setData({ messages: list });
        this.scrollToBottom();
      })
      .catch((e) => {
        this.failLocal(key, (e && e.message) || '发送失败，请重试');
      });
  },

  /* ============================ 图片 / 视频 / 文件 ============================ */

  onCamera() {
    this._sourceType = 'camera';
    this.setData({ panel: false });
    this.pickImage();
  },

  onAlbum() {
    this._sourceType = 'album';
    this.setData({ panel: false });
    this.pickImage();
  },

  pickImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: [this._sourceType || 'album'],
      sizeType: ['compressed'],
      success: (r) => {
        const f = (r.tempFiles && r.tempFiles[0]) || null;
        if (!f) return;
        const key = this.pushLocal({
          type: 'image',
          mediaUrl: f.tempFilePath, // 先用本地路径显示，上传成功后替换
          meta: { size: f.size, width: f.width, height: f.height },
        });
        wx.showLoading({ title: '上传中', mask: true });
        serviceApi
          .upload(f.tempFilePath, 'image')
          .then((res) => {
            wx.hideLoading();
            const meta = { size: res.size, width: f.width, height: f.height };
            this.patchLocal(key, { mediaUrl: res.url, meta: meta, sizeText: sizeText(res.size) });
            this.doSend(key, { type: 'image', mediaUrl: res.url, meta: meta });
          })
          .catch((e) => {
            wx.hideLoading();
            this.failLocal(key, (e && e.message) || '图片上传失败');
          });
      },
      fail: (e) => {
        if (String((e && e.errMsg) || '').indexOf('cancel') > -1) return;
        toast('打开相册失败，请检查权限');
      },
    });
  },

  onVideo() {
    this.setData({ panel: false });
    wx.chooseMedia({
      count: 1,
      mediaType: ['video'],
      sourceType: ['album', 'camera'],
      maxDuration: 15,
      camera: 'back',
      success: (r) => {
        const f = (r.tempFiles && r.tempFiles[0]) || null;
        if (!f) return;
        const duration = Math.round(f.duration || 0);
        const key = this.pushLocal({
          type: 'video',
          mediaUrl: f.tempFilePath,
          meta: { size: f.size, duration: duration },
        });
        wx.showLoading({ title: '上传中', mask: true });
        serviceApi
          .upload(f.tempFilePath, 'video')
          .then((res) => {
            wx.hideLoading();
            const meta = { size: res.size, duration: duration };
            this.patchLocal(key, { mediaUrl: res.url, meta: meta, sizeText: sizeText(res.size) });
            this.doSend(key, { type: 'video', mediaUrl: res.url, meta: meta });
          })
          .catch((e) => {
            wx.hideLoading();
            this.failLocal(key, (e && e.message) || '视频上传失败');
          });
      },
      fail: (e) => {
        if (String((e && e.errMsg) || '').indexOf('cancel') > -1) return;
        toast('选择视频失败');
      },
    });
  },

  onFile() {
    this.setData({ panel: false });
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'txt', 'csv', 'zip'],
      success: (r) => {
        const f = (r.tempFiles && r.tempFiles[0]) || null;
        if (!f) return;
        if (f.size > config.UPLOAD_FILE_MAX) return toast('文件超过 10MB，请压缩后再发送');
        const key = this.pushLocal({ type: 'file', mediaUrl: '', meta: { name: f.name, size: f.size } });
        wx.showLoading({ title: '上传中', mask: true });
        serviceApi
          .upload(f.path, 'file')
          .then((res) => {
            wx.hideLoading();
            const meta = { name: f.name, size: f.size };
            this.patchLocal(key, { mediaUrl: res.url, meta: meta });
            this.doSend(key, { type: 'file', mediaUrl: res.url, meta: meta });
          })
          .catch((e) => {
            wx.hideLoading();
            this.failLocal(key, (e && e.message) || '文件上传失败');
          });
      },
      fail: () => {},
    });
  },

  /* ============================ 录音 ============================ */

  initRecorder() {
    this.recorder = wx.getRecorderManager();
    this.recorder.onStop((res) => {
      this.setData({ recording: false });
      if (this.recTimer) clearTimeout(this.recTimer);
      const duration = Math.max(1, Math.round((res.duration || 0) / 1000));
      if (!res.tempFilePath) return;
      const key = this.pushLocal({ type: 'voice', mediaUrl: res.tempFilePath, meta: { duration: duration, size: 0 } });
      wx.showLoading({ title: '上传中', mask: true });
      serviceApi
        .upload(res.tempFilePath, 'voice')
        .then((r2) => {
          wx.hideLoading();
          const meta = { duration: duration, size: r2.size };
          this.patchLocal(key, { mediaUrl: r2.url, meta: meta });
          this.doSend(key, { type: 'voice', mediaUrl: r2.url, meta: meta });
        })
        .catch((e) => {
          wx.hideLoading();
          this.failLocal(key, (e && e.message) || '语音上传失败');
        });
    });
    this.recorder.onError((e) => {
      this.setData({ recording: false });
      toast('录音失败：' + ((e && e.errMsg) || '请检查麦克风权限'));
    });
  },

  onVoice() {
    if (this.data.recording) {
      this.recorder.stop();
      return;
    }
    this.recorder.start({ duration: 60000, format: 'mp3', sampleRate: 16000, numberOfChannels: 1, encodeBitRate: 32000 });
    this.setData({ recording: true });
    /* 兜底自动停止：避免个别机型 onStop 不回调导致 UI 卡在「录音中」 */
    this.recTimer = setTimeout(() => {
      if (this.data.recording) this.recorder.stop();
    }, 62000);
  },

  /* ============================ 消息交互 ============================ */

  onPreviewImage(e) {
    const url = e.currentTarget.dataset.url;
    if (!url) return;
    wx.previewImage({ current: url, urls: [url] });
  },

  onPlayVoice(e) {
    const { key, url } = e.currentTarget.dataset;
    if (!url) return toast('语音文件不可用');
    if (this.data.playingId === key) {
      if (this.audio) this.audio.stop();
      this.setData({ playingId: '' });
      return;
    }
    if (!this.audio) this.audio = wx.createInnerAudioContext();
    this.audio.src = /^https?:/.test(url) ? url : config.ORIGIN + url;
    this.audio.onEnded(() => this.setData({ playingId: '' }));
    this.audio.onError(() => {
      this.setData({ playingId: '' });
      toast('播放失败，请重试');
    });
    this.audio.play();
    this.setData({ playingId: key });
  },

  onOpenFile(e) {
    const { url } = e.currentTarget.dataset;
    if (!url) return toast('文件不可用');
    wx.showLoading({ title: '打开中', mask: true });
    wx.downloadFile({
      url: /^https?:/.test(url) ? url : config.ORIGIN + url,
      success: (r) => {
        wx.hideLoading();
        wx.openDocument({
          filePath: r.tempFilePath,
          showMenu: true,
          fail: () => toast('该文件类型暂不支持预览'),
        });
      },
      fail: () => {
        wx.hideLoading();
        toast('文件下载失败');
      },
    });
  },

  onCloseSession() {
    confirm('结束后需要重新发起会话，确定结束？', '结束会话').then((ok) => {
      if (!ok) return;
      serviceApi
        .close()
        .then(() => {
          toast('会话已结束', 'success');
          setTimeout(() => wx.navigateBack(), 600);
        })
        .catch((e) => toastError(e));
    });
  },

  onShareAppMessage() {
    return { title: '老北京麻辣串串香 · 在线客服', path: '/pages/menu/menu' };
  },
});
