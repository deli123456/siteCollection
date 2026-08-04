/* ============================================================
 * 路网坐标点采集 - 高德 JS API 2.0
 * 功能:
 *  1) GPS 实时定位 -> convertFrom(GCJ02) -> GraspRoad 路网吸附
 *  2) 卫星图/标准图切换
 *  3) 采集时 POI 周边搜索(公交/小区/学校/医院/大厦) + 站点命名(可手动编辑)
 *  4) 手动点击地图校准 GPS + 最近道路吸附(弱信号时使用)
 * ============================================================ */
(function () {
  'use strict';

  // ---------------- 配置 ----------------
  const CONFIG = {
    minAccuracy: 30,       // 定位精度阈值(米)
    minMoveDist: 3,        // 抖动过滤(米)
    windowSize: 10,        // 纠偏滑动窗口
    graspMinPoints: 2,
    poiRadius: 1000,       // POI 周边搜索半径(米)
    manualSnapMaxDist: 300, // 手动校准吸附最大距离(米)，超出视为无效
    // 轨迹惯性稳定化(防止吸附点在平行道路间来回跳)
    jumpLateral: 10,       // 横向偏移超过此值(米)视为可疑跳变
    jumpSupport: 6,        // 吸附点横向偏移需比原始GPS大出此值才算“无支撑”(米)
    switchVotesNeeded: 3,  // 连续多少次一致横向证据才认可真正换路
    moveBearingMin: 6,     // 净位移超过此值才信任行进方向(米)
    snapHistorySize: 10,   // 稳定化历史点个数
    snapResetGapMs: 8000,  // 两次吸附间隔超时则重置轨迹(毫秒)
    // 候选道路匹配(自动模式多平行道路 map-matching)
    candRefreshMs: 4000,   // 候选道路刷新最小间隔(毫秒)
    candAhead: 150,        // 沿行进方向前视距离(米)
    candBehind: 100,       // 沿行进方向后视距离(米)，保证垂足不落在折线端点
    candLateral: 18,       // 侧向偏移采样距离(米)，用于发现平行主/辅路
    candSameDist: 8,       // 两候选投影点距离小于此值视为同一条道路(米)
    candMaxDist: 80,       // 候选道路距离上限(米)
    trajSimN: 6,           // 轨迹曲线相似度参与的原始GPS点数
    maxKmh: 200,           // 前后吸附点位移的最大合理速度(km/h)，连通性校验
    wTraj: 1.0,            // 轨迹曲线相似度权重(米)
    wHead: 0.6,            // 方向角差权重(度→米折算)
    stickyBonus: 12,       // 保持当前道路的迟滞加分(米)
    pinBonus: 40,          // 人工指定道路的优先加分(米)
    pinMissMax: 2,         // 人工道路连续丢失多少轮后解除
    altWin: 8,             // 海拔窗口大小
    altTrendMin: 5,        // 窗口内海拔变化超过此值(米)判定为爬升/下降(立交/隧道)
    altStickyExtra: 20,    // 垂直变化期间额外的道路保持加分(米)
    storeKey: 'siteCollection.points.v1',
    levelKey: 'siteCollection.roadLevels.v1'
  };

  // 道路等级 -> 高德路径规划引擎映射
  const ROAD_LEVELS = ['walk', 'ride', 'drive'];

  // POI 分类配置(公交站排第一)
  const POI_CATS = [
    { key: 'bus',         label: '公交站', icon: '🚌', type: '150700', limit: 3, first: true },
    { key: 'residential', label: '小区',   icon: '🏘️', type: '120300', limit: 2 },
    { key: 'building',    label: '大厦',   icon: '🏢', type: '120200', limit: 2 },
    { key: 'school',      label: '学校',   icon: '🏫', type: '141200', limit: 2 },
    { key: 'hospital',    label: '医院',   icon: '🏥', type: '090100', limit: 2 }
  ];

  // ---------------- DOM ----------------
  const $ = (id) => document.getElementById(id);
  const el = {
    gpsDot: $('gpsDot'), gpsText: $('gpsText'), accText: $('accText'), snapText: $('snapText'),
    countText: $('countText'), curCoord: $('curCoord'),
    btnLocate: $('btnLocate'), btnCollect: $('btnCollect'), btnMenu: $('btnMenu'),
    btnLayer: $('btnLayer'), modeAuto: $('modeAuto'), modeManual: $('modeManual'),
    mask: $('mask'), sheet: $('sheet'),
    btnList: $('btnList'), btnExportCsv: $('btnExportCsv'),
    btnUndo: $('btnUndo'), btnClear: $('btnClear'), btnCloseSheet: $('btnCloseSheet'),
    btnRoadLevel: $('btnRoadLevel'), lvlMask: $('lvlMask'), lvlModal: $('lvlModal'), lvlClose: $('lvlClose'),
    btnRoadSwitch: $('btnRoadSwitch'),
    listPanel: $('listPanel'), listBody: $('listBody'), btnCloseList: $('btnCloseList'),
    toast: $('toast'),
    nameMask: $('nameMask'), nameModal: $('nameModal'), nmCancel: $('nmCancel'),
    nmCoord: $('nmCoord'), nmSnap: $('nmSnap'), nameInput: $('nameInput'),
    poiList: $('poiList'), poiTip: $('poiTip'), nmConfirm: $('nmConfirm'),
    lvlCbs: document.querySelectorAll('.lvl-cb')
  };

  // ---------------- 状态 ----------------
  const state = {
    map: null,
    graspRoad: null,
    geocoder: null,
    driving: null,             // 驾车路径规划(手动校准吸附用)
    walking: null,             // 步行路径规划(覆盖辅路/人行道)
    riding: null,              // 骑行路径规划(覆盖非机动道)
    watchId: null,
    wakeLock: null,
    followMode: true,
    manualMode: false,         // 手动校准模式
    satelliteOn: false,
    rawWindow: [],
    roadLevels: new Set(ROAD_LEVELS),  // 启用的道路等级(默认全选)
    // 候选道路匹配状态
    fusedBrg: null,            // 融合方向角(轨迹方向 + 设备上报方向角)
    candidates: [],            // 候选道路 [{path, prj, avgTrajDist, score, isCurrent, isPinned}]
    candTm: 0,                 // 上次候选刷新时间戳
    curPath: null,             // 当前吸附道路折线
    pinned: false,             // 人工指定道路生效中
    pinnedPath: null,          // 人工指定道路折线
    pinMiss: 0,                // 人工道路连续丢失计数
    switchIdx: 0,              // 切换道路轮换下标
    lastSnap: null,            // 上次吸附提交点 {lng,lat,tm}，连通性/速度合理性校验用
    altWindow: [],             // 最近海拔采样(米)
    lastAlt: null,             // 最近一次海拔(米)
    snapHistory: [],           // 已接受的吸附点轨迹(用于惯性稳定化)
    roadSwitchVotes: 0,        // 连续横向跳变计数
    lastSnapTm: 0,             // 上次吸附时间戳
    current: null,             // 待采集点 { lng, lat, snapped, accuracy, manual }
    lastRaw: null,
    collected: [],
    poiToken: 0,               // POI 查询防抖标识
    // 图层元素
    satellite: null, roadNet: null,
    locMarker: null, accCircle: null,
    rawMarker: null,         // 原始GPS点标记(有吸附点时弱化，无吸附点时鲜明)
    manualRawMarker: null,     // 手动点击的原始点(灰)
    trackLine: null, collectMarkers: []
  };

  // ============================================================
  // 工具
  // ============================================================
  function toast(msg, dur) {
    el.toast.textContent = msg;
    el.toast.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.toast.classList.add('hidden'), dur || 1800);
  }
  function vibrate(ms) { if (navigator.vibrate) { try { navigator.vibrate(ms || 30); } catch (e) {} } }

  function distance(a, b) {
    const R = 6378137, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const s = Math.sin(dLat / 2) ** 2 +
      Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  }
  function bearing(a, b) {
    const rad = Math.PI / 180;
    const y = Math.sin((b.lng - a.lng) * rad) * Math.cos(b.lat * rad);
    const x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad) -
      Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lng - a.lng) * rad);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }
  function fmt(n, d) { return Number(n).toFixed(d == null ? 6 : d); }

  // 局部平面坐标(以 origin 为原点，东=x 北=y，单位米)
  function localXY(origin, p) {
    const rad = Math.PI / 180, R = 6378137, cosLat = Math.cos(origin.lat * rad);
    return { x: (p.lng - origin.lng) * rad * cosLat * R, y: (p.lat - origin.lat) * rad * R };
  }
  // 从 from 沿 bearing(度) 前进 dist 米的目标点
  function destPoint(from, brgDeg, dist) {
    const rad = Math.PI / 180, R = 6378137, b = brgDeg * rad;
    const dLat = (dist * Math.cos(b)) / R / rad;
    const dLng = (dist * Math.sin(b)) / (R * Math.cos(from.lat * rad)) / rad;
    return { lng: from.lng + dLng, lat: from.lat + dLat };
  }
  // 当前行进方向: 优先取原始窗口净位移，不足则取吸附历史；静止时返回 null
  function trajectoryBearing() {
    const w = state.rawWindow;
    if (w.length >= 2) {
      const a = w[0], b = w[w.length - 1];
      if (distance(a, b) >= CONFIG.moveBearingMin) return bearing(a, b);
    }
    const h = state.snapHistory;
    if (h.length >= 2) {
      const a = h[0], b = h[h.length - 1];
      if (distance(a, b) >= CONFIG.moveBearingMin) return bearing(a, b);
    }
    return null;
  }
  function pushSnapHistory(pt) {
    state.snapHistory.push({ lng: pt.lng, lat: pt.lat });
    if (state.snapHistory.length > CONFIG.snapHistorySize) state.snapHistory.shift();
  }
  function lnglatOf(e) {
    const p = e.lnglat || e;
    return { lng: p.getLng ? p.getLng() : p.lng, lat: p.getLat ? p.getLat() : p.lat };
  }

  // ============================================================
  // 地图初始化
  // ============================================================
  function initMap() {
    if (typeof AMap === 'undefined') {
      toast('高德地图加载失败，请检查网络或 Key 配置', 5000);
      setGps('err', 'JS API 未加载');
      return;
    }
    state.map = new AMap.Map('map', {
      zoom: 17, center: [116.397428, 39.90923],
      resizeEnable: true, showBuildingBlock: true
    });

    // 插件实例
    if (AMap.GraspRoad) state.graspRoad = new AMap.GraspRoad();
    if (AMap.Geocoder) state.geocoder = new AMap.Geocoder({ extensions: 'all', radius: 1000 });
    if (AMap.Driving) state.driving = new AMap.Driving({ ferry: 1 });
    if (AMap.Walking) state.walking = new AMap.Walking();
    if (AMap.Riding) state.riding = new AMap.Riding();
    if (AMap.PlaceSearch) {
      POI_CATS.forEach((c) => {
        c._search = new AMap.PlaceSearch({ type: c.type, pageSize: 10, extensions: 'base' });
      });
    }

    // 卫星图层(默认不加载)
    state.satellite = new AMap.TileLayer.Satellite();
    state.roadNet = new AMap.TileLayer.RoadNet();

    state.trackLine = null;

    // 拖动地图关闭跟随
    state.map.on('touchstart', () => { if (!state.manualMode) state.followMode = false; });
    state.map.on('mousedown', () => { if (!state.manualMode) state.followMode = false; });
    // 手动校准：点击地图选点
    state.map.on('click', (e) => { if (state.manualMode) onManualPick(lnglatOf(e)); });

    restore();
    loadLevels();
    startWatch();
    requestWakeLock();
  }

  // ============================================================
  // 卫星图切换
  // ============================================================
  function toggleSatellite() {
    state.satelliteOn = !state.satelliteOn;
    if (state.satelliteOn) {
      state.map.add([state.satellite, state.roadNet]);
      el.btnLayer.textContent = '标准';
      el.btnLayer.classList.add('active');
    } else {
      state.map.remove([state.satellite, state.roadNet]);
      el.btnLayer.textContent = '卫星';
      el.btnLayer.classList.remove('active');
    }
  }

  // ============================================================
  // GPS 定位追踪
  // ============================================================
  function setGps(level, text) {
    el.gpsDot.className = 'dot ' + (level || '');
    if (text != null) el.gpsText.textContent = text;
  }

  function startWatch() {
    if (!('geolocation' in navigator)) {
      setGps('err', '设备不支持定位');
      toast('当前设备/浏览器不支持定位，可切换“手动”模式选点', 4000);
      return;
    }
    setGps('warn', '定位中…');
    state.watchId = navigator.geolocation.watchPosition(
      onPosition, onPositionError,
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
    );
  }

  function onPositionError(err) {
    const m = { 1: '定位权限被拒绝', 2: '定位不可用', 3: '定位超时' };
    setGps('err', m[err.code] || '定位失败');
    toast((m[err.code] || '定位失败') + '，可切换“手动”模式选点', 3500);
  }

  function onPosition(pos) {
    const c = pos.coords, accuracy = c.accuracy || 999;
    el.accText.textContent = '精度 ' + Math.round(accuracy) + 'm';

    // 海拔采样(供立交/隧道等垂直分离道路的匹配保持参考)
    if (c.altitude != null && !isNaN(c.altitude)) {
      state.lastAlt = c.altitude;
      state.altWindow.push(c.altitude);
      if (state.altWindow.length > CONFIG.altWin) state.altWindow.shift();
    }

    if (accuracy > CONFIG.minAccuracy) {
      setGps('warn', 'GPS 弱(±' + Math.round(accuracy) + 'm)');
      return;
    }
    setGps('ok', state.manualMode ? '手动模式' : '定位正常');
    if (state.manualMode) return; // 手动模式下不让 GPS 覆盖当前点

    const wgs = [c.longitude, c.latitude];
    if (AMap.convertFrom) {
      AMap.convertFrom(wgs, 'gps', (status, result) => {
        if (status === 'complete' && result.info === 'ok' && result.locations.length) {
          const p = result.locations[0];
          handleGcj({ lng: p.lng, lat: p.lat }, c, accuracy);
        } else {
          handleGcj({ lng: wgs[0], lat: wgs[1] }, c, accuracy);
        }
      });
    } else {
      handleGcj({ lng: wgs[0], lat: wgs[1] }, c, accuracy);
    }
  }

  function handleGcj(gcj, coords, accuracy) {
    const now = Date.now();
    if (state.lastRaw && distance(state.lastRaw, gcj) < CONFIG.minMoveDist) {
      updateRawVisual(gcj, accuracy); // 抖动过滤: 仅刷新原始点视觉
      return;
    }
    let sp = coords.speed;
    if (sp == null || isNaN(sp) || sp < 0) {
      if (state.lastRaw) {
        const dt = (now - state.lastRaw.tm) / 1000;
        sp = dt > 0 ? distance(state.lastRaw, gcj) / dt : 0;
      } else sp = 0;
    }
    let ag = coords.heading;
    if (ag == null || isNaN(ag)) ag = state.lastRaw ? bearing(state.lastRaw, gcj) : 0;

    const point = { lng: gcj.lng, lat: gcj.lat, sp: sp, ag: ag, tm: now };
    state.lastRaw = point;
    state.rawWindow.push(point);
    if (state.rawWindow.length > CONFIG.windowSize) state.rawWindow.shift();
    updateRawVisual(gcj, accuracy); // 原始GPS点(弱化色)
    snapToRoad(accuracy);
  }

  // ============================================================
  // 道路等级 -> 启用引擎
  // ============================================================
  function enabledEngines() {
    const out = [];
    if (state.roadLevels.has('walk') && state.walking) out.push(state.walking);
    if (state.roadLevels.has('ride') && state.riding) out.push(state.riding);
    if (state.roadLevels.has('drive') && state.driving) out.push(state.driving);
    return out;
  }

  // 道路等级选择: 持久化 + 应用到勾选框
  function loadLevels() {
    let saved = null;
    try {
      const raw = localStorage.getItem(CONFIG.levelKey);
      if (raw) saved = JSON.parse(raw);
    } catch (e) {}
    if (saved && Array.isArray(saved) && saved.length) {
      state.roadLevels = new Set(saved.filter((k) => ROAD_LEVELS.indexOf(k) >= 0));
    }
    // 同步勾选框显示
    (el.lvlCbs || []).forEach((cb) => {
      cb.checked = state.roadLevels.has(cb.getAttribute('data-lvl'));
    });
  }
  function saveLevels() {
    try { localStorage.setItem(CONFIG.levelKey, JSON.stringify(Array.from(state.roadLevels))); } catch (e) {}
  }
  function onLevelChange() {
    const next = new Set();
    (el.lvlCbs || []).forEach((cb) => { if (cb.checked) next.add(cb.getAttribute('data-lvl')); });
    if (next.size === 0) {
      toast('至少需勾选一个道路等级');
      // 恢复勾选状态
      (el.lvlCbs || []).forEach((cb) => { cb.checked = state.roadLevels.has(cb.getAttribute('data-lvl')); });
      return;
    }
    state.roadLevels = next;
    saveLevels();
    // 等级变化: 重置候选道路与人工指定，下次吸附按新等级重新匹配
    state.curPath = null; state.candidates = []; state.candTm = 0;
    state.pinned = false; state.pinnedPath = null; state.pinMiss = 0;
    updateSwitchBtn();
    const names = { walk: '步行道', ride: '骑行道', drive: '机动车道' };
    const labels = Array.from(state.roadLevels).map((k) => names[k]).join('、');
    toast('吸附道路等级：' + labels, 2200);
  }

  // ============================================================
  // 路网吸附(自动模式: 候选道路 map-matching)
  // 思路: 多起点×多引擎短距规划发现附近候选道路(含平行主/辅路)，
  // 综合评分 = 轨迹曲线相似度 + 方向角匹配 + 连通性速度校验
  //           + 当前道路迟滞保持(海拔变化期加强) + 人工指定优先
  // ============================================================
  function snapToRoad(accuracy) {
    if (state.manualMode) return;
    const win = state.rawWindow, rawLast = win[win.length - 1];
    const lv = state.roadLevels;
    if (!lv || lv.size === 0) {
      commitCurrent({ lng: rawLast.lng, lat: rawLast.lat, snapped: false, accuracy });
      return;
    }
    updateFusedBearing(rawLast);
    const engines = enabledEngines();
    if (!engines.length) { graspFallback(rawLast, accuracy); return; }
    autoSnapMatch(rawLast, accuracy, engines);
  }

  // ---- 方向角融合: 轨迹方向 + GPS模块上报方向角(有速度时才可信) ----
  function angDiff(a, b) { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }
  function mixAngle(a, b, wa) { // 圆均值(处理 359°/1° 跨界)
    const rad = Math.PI / 180;
    const x = Math.cos(a * rad) * wa + Math.cos(b * rad) * (1 - wa);
    const y = Math.sin(a * rad) * wa + Math.sin(b * rad) * (1 - wa);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }
  function updateFusedBearing(rawLast) {
    const tb = trajectoryBearing();
    let dev = null;
    if (rawLast && rawLast.ag != null && !isNaN(rawLast.ag) && rawLast.sp > 1.5) dev = rawLast.ag;
    let brg = null;
    if (tb != null && dev != null) brg = mixAngle(tb, dev, 0.6); // 轨迹方向权重更高
    else brg = tb != null ? tb : dev;
    if (brg == null) return;
    state.fusedBrg = state.fusedBrg == null ? brg : mixAngle(brg, state.fusedBrg, 0.7); // 平滑
  }

  // 海拔窗口是否处于明显爬升/下降(立交匠道/隧道口等，此时加强道路保持)
  function altChanging() {
    if (state.altWindow.length < 3) return false;
    return Math.max.apply(null, state.altWindow) - Math.min.apply(null, state.altWindow) >= CONFIG.altTrendMin;
  }

  // ---- 自动模式候选道路匹配主流程 ----
  function autoSnapMatch(rawLast, accuracy, engines) {
    const now = Date.now();
    // 候选未到刷新时间: 直接在当前道路上本地投影(免接口)
    if (now - state.candTm < CONFIG.candRefreshMs) {
      if (state.curPath) {
        const prj = projectOnPath(rawLast, state.curPath);
        if (prj && prj.dist <= CONFIG.candMaxDist) { commitSnap(prj, accuracy); return; }
      }
      commitCurrent({ lng: rawLast.lng, lat: rawLast.lat, snapped: false, accuracy });
      return;
    }
    state.candTm = now;
    refreshCandidates(rawLast, engines, (cands) => {
      if (state.manualMode) return;
      state.candidates = cands;
      if (!cands.length) { graspFallback(rawLast, accuracy); updateSwitchBtn(); return; }
      const best = pickBestCandidate(cands, rawLast);
      state.curPath = best.path;
      const prj = projectOnPath(rawLast, best.path) || best.prj;
      commitSnap(prj, accuracy);
      updateSwitchBtn();
    });
  }

  function commitSnap(prj, accuracy) {
    state.lastSnap = { lng: prj.point.lng, lat: prj.point.lat, tm: Date.now() };
    pushSnapHistory(prj.point);
    commitCurrent({ lng: prj.point.lng, lat: prj.point.lat, snapped: true, accuracy });
  }

  // 并行发起 多起点×多引擎×前后双向 短距规划，汇总去重得到附近候选道路(含平行主/辅路)
  function refreshCandidates(rawLast, engines, done) {
    const brg = state.fusedBrg;
    // 前后各规划一段，折线覆盖当前位置前后足够长的道路，避免垂足被钳到端点
    const destFwd = brg != null ? destPoint(rawLast, brg, CONFIG.candAhead)
                                : { lng: rawLast.lng + 0.0015, lat: rawLast.lat };
    const destBack = brg != null ? destPoint(rawLast, (brg + 180) % 360, CONFIG.candBehind) : null;
    const origins = [rawLast];
    if (brg != null) { // 垂直行进方向左右偏移采样，用于发现旁边的平行道路
      origins.push(destPoint(rawLast, brg + 90, CONFIG.candLateral));
      origins.push(destPoint(rawLast, brg - 90, CONFIG.candLateral));
    }
    const dests = destBack ? [destFwd, destBack] : [destFwd];
    const tasks = [];
    engines.forEach((eng, ei) => {
      dests.forEach((d) => tasks.push({ eng: eng, o: origins[0], d: d }));
      // 侧向偏移起点仅用第一个引擎的前向目标(控制接口调用量)
      if (ei === 0) for (let i = 1; i < origins.length; i++) tasks.push({ eng: eng, o: origins[i], d: destFwd });
    });
    let pending = tasks.length;
    const cands = [];
    tasks.forEach((t) => {
      t.eng.search([t.o.lng, t.o.lat], [t.d.lng, t.d.lat], (status, result) => {
        if (status === 'complete' && result.routes && result.routes.length) {
          const path = collectRoutePath(result.routes[0]);
          if (path.length >= 2) addCandidate(cands, rawLast, path);
        }
        if (--pending === 0) done(cands);
      });
    });
  }

  function addCandidate(cands, rawLast, path) {
    const prj = projectOnPath(rawLast, path);
    if (!prj || prj.dist > CONFIG.candMaxDist) return;
    // 去重: 投影点足够近视为同一条道路，保留距离更近的
    for (let i = 0; i < cands.length; i++) {
      if (distance(prj.point, cands[i].prj.point) < CONFIG.candSameDist) {
        if (prj.dist < cands[i].prj.dist) cands[i] = makeCand(path, prj);
        return;
      }
    }
    cands.push(makeCand(path, prj));
  }

  function makeCand(path, prj) {
    // 轨迹曲线相似度: 最近N个原始GPS点到该道路的平均距离(越小越像在这条路上)
    const pts = state.rawWindow.slice(-CONFIG.trajSimN);
    let sum = 0, n = 0;
    pts.forEach((p) => { const pr = projectOnPath(p, path); if (pr) { sum += pr.dist; n++; } });
    return { path: path, prj: prj, avgTrajDist: n ? sum / n : prj.dist };
  }

  function pickBestCandidate(cands, rawLast) {
    const now = Date.now();
    const altHold = altChanging();
    const curPrj = state.curPath ? projectOnPath(rawLast, state.curPath) : null;
    const pinPrj = (state.pinned && state.pinnedPath) ? projectOnPath(rawLast, state.pinnedPath) : null;
    let pinSeen = false;
    cands.forEach((c) => {
      c.isCurrent = !!(curPrj && distance(c.prj.point, curPrj.point) < CONFIG.candSameDist);
      c.isPinned = !!(pinPrj && distance(c.prj.point, pinPrj.point) < CONFIG.candSameDist * 1.5);
      if (c.isPinned) pinSeen = true;
      // 评分(越小越好)
      let s = c.avgTrajDist * CONFIG.wTraj;                                  // 1) 轨迹曲线相似度
      if (state.fusedBrg != null && c.prj.segBrg != null) {
        // 反向规划折线的方向与行进方向相反，取两个方向中较小的夹角
        const dA = angDiff(state.fusedBrg, c.prj.segBrg);
        s += Math.min(dA, 360 - dA) * CONFIG.wHead;                          // 2) 融合方向角 vs 道路方向
      }
      if (state.lastSnap) {                                                  // 5) 连通性/速度合理性校验
        const dt = (now - state.lastSnap.tm) / 1000;
        if (dt > 0.3) {
          const kmh = distance(state.lastSnap, c.prj.point) / dt * 3.6;
          if (kmh > CONFIG.maxKmh) s += 10000; // 达到该点需超合理速度 → 基本排除
        }
      }
      if (c.isCurrent) s -= CONFIG.stickyBonus + (altHold ? CONFIG.altStickyExtra : 0); // 3) 垂直变化期加强保持
      if (c.isPinned) s -= CONFIG.pinBonus;                                  // 4) 人工指定优先
      c.score = s;
    });
    // 人工指定道路丢失处理(连续丢失若干轮后自动解除)
    if (state.pinned) {
      if (pinSeen) state.pinMiss = 0;
      else if (++state.pinMiss >= CONFIG.pinMissMax) {
        state.pinned = false; state.pinnedPath = null; state.pinMiss = 0;
        toast('已离开人工指定道路，恢复自动判断');
      }
    }
    // 人工指定道路仍在场时更新其折线(后续延伸传承)
    cands.forEach((c) => { if (c.isPinned) state.pinnedPath = c.path; });
    cands.sort((a, b) => a.score - b.score);
    return cands[0];
  }

  // 候选道路全部落空时: 机动车道场景退回 GraspRoad 轨迹纠偏
  function graspFallback(rawLast, accuracy) {
    const win = state.rawWindow;
    if (!(state.roadLevels.has('drive') && state.graspRoad && win.length >= CONFIG.graspMinPoints)) {
      commitCurrent({ lng: rawLast.lng, lat: rawLast.lat, snapped: false, accuracy });
      return;
    }
    const path = win.map((p) => ({
      x: p.lng, y: p.lat,
      sp: Math.round(p.sp * 3.6), ag: Math.round(p.ag), tm: Math.round(p.tm / 1000)
    }));
    state.graspRoad.driving(path, (err, result) => {
      if (state.manualMode) return;
      if (!err && result && result.data && result.data.points && result.data.points.length) {
        const pts = result.data.points, last = pts[pts.length - 1];
        const lng = last.x != null ? last.x : (last.lng != null ? last.lng : last[0]);
        const lat = last.y != null ? last.y : (last.lat != null ? last.lat : last[1]);
        const stable = stabilizeSnap({ lng: lng, lat: lat }, rawLast, accuracy);
        commitCurrent({ lng: stable.lng, lat: stable.lat, snapped: true, accuracy });
      } else {
        commitCurrent({ lng: rawLast.lng, lat: rawLast.lat, snapped: false, accuracy });
      }
    });
  }

  // ---- 道路切换按钮(同向多候选时人工快速切换，类似导航主/辅路切换) ----
  function updateSwitchBtn() {
    const n = state.candidates.length;
    const show = !state.manualMode && n >= 2;
    el.btnRoadSwitch.classList.toggle('hidden', !show);
    if (show) el.btnRoadSwitch.textContent = '切换道路(' + n + ')';
  }

  function onRoadSwitch() {
    const others = state.candidates.filter((c) => !c.isCurrent); // 排除当前已匹配道路
    if (!others.length) { toast('附近没有其他备选道路'); return; }
    state.switchIdx = state.switchIdx % others.length;
    const pick = others[state.switchIdx];
    state.switchIdx++;
    // 人工指定: 后续匹配优先保持该道路及其延伸
    state.pinned = true;
    state.pinnedPath = pick.path;
    state.pinMiss = 0;
    state.curPath = pick.path;
    state.candidates.forEach((c) => { c.isCurrent = c === pick; });
    const rawLast = state.rawWindow[state.rawWindow.length - 1];
    const prj = (rawLast ? projectOnPath(rawLast, pick.path) : null) || pick.prj;
    commitSnap(prj, state.current ? (state.current.accuracy || 0) : 0);
    toastRoadName(prj.point, Math.round(prj.dist));
    vibrate(20);
  }

  // 轨迹惯性稳定化: 根据连续历史 GPS 判断当前道路，修正“吸到平行道路”的跳变
  function stabilizeSnap(candidate, rawLast, accuracy) {
    const now = Date.now();
    // 长时间无更新(如中途信号丢失/暂停) -> 重置轨迹，重新起步
    if (state.lastSnapTm && now - state.lastSnapTm > CONFIG.snapResetGapMs) {
      state.snapHistory = [];
      state.roadSwitchVotes = 0;
    }
    state.lastSnapTm = now;

    // 历史不足 -> 直接接受
    if (state.snapHistory.length < 1) { pushSnapHistory(candidate); return candidate; }
    const prev = state.snapHistory[state.snapHistory.length - 1];

    // 无法确定行进方向(静止/微动) -> 直接接受，不做修正
    const brg = trajectoryBearing();
    if (brg == null) { pushSnapHistory(candidate); return candidate; }

    const rad = Math.PI / 180, sinB = Math.sin(brg * rad), cosB = Math.cos(brg * rad);
    const cand = localXY(prev, candidate);
    const raw = localXY(prev, rawLast);
    const alongC = cand.x * sinB + cand.y * cosB;      // 吸附点沿行进方向分量
    const latC = cand.x * cosB - cand.y * sinB;        // 吸附点横向分量(右为正)
    const latR = raw.x * cosB - raw.y * sinB;          // 原始GPS横向分量

    // 吸附点横向偏移大，且比原始GPS明显更偏 -> 可疑“跳到平行道路”
    if (Math.abs(latC) > CONFIG.jumpLateral &&
        Math.abs(latC) - Math.abs(latR) > CONFIG.jumpSupport) {
      state.roadSwitchVotes++;
      if (state.roadSwitchVotes < CONFIG.switchVotesNeeded) {
        // 惯性保持当前道路: 将前进量投影到当前行进方向线上
        const held = destPoint(prev, brg, Math.max(0, alongC));
        pushSnapHistory(held);
        return held;
      }
      // 连续多次一致 -> 确实换路，接受并重置计数
      state.roadSwitchVotes = 0;
      state.snapHistory = [];
      pushSnapHistory(candidate);
      return candidate;
    }

    // 横向正常/有原始GPS支撑 -> 接受，清零计数
    state.roadSwitchVotes = 0;
    pushSnapHistory(candidate);
    return candidate;
  }

  function commitCurrent(pt) {
    state.current = pt;
    el.snapText.textContent = pt.snapped ? '吸附道路 ✓' : '吸附道路 ✗';
    el.curCoord.textContent = fmt(pt.lng) + ', ' + fmt(pt.lat);
    el.btnCollect.disabled = false;
    updateLocationVisual(pt, pt.accuracy);
  }

  // ============================================================
  // 手动校准: 点击地图 -> 最近道路吸附
  // ============================================================
  function setModeUI() {
    el.modeAuto.classList.toggle('active', !state.manualMode);
    el.modeManual.classList.toggle('active', state.manualMode);
  }

  function toggleManual() {
    state.manualMode = !state.manualMode;
    setModeUI();
    if (state.manualMode) {
      state.followMode = false;
      // 重置自动轨迹，避免切回自动后用陈旧历史判断
      state.snapHistory = [];
      state.roadSwitchVotes = 0;
      el.btnRoadSwitch.classList.add('hidden');
      // 吸附点立即切为手动主题色(橙色)
      if (state.locMarker) state.locMarker.setContent('<div class="loc-dot manual"></div>');
      toast('手动模式：点击地图选择位置，将自动吸附最近道路', 2600);
    } else {
      if (state.manualRawMarker) { state.map.remove(state.manualRawMarker); state.manualRawMarker = null; }
      // 切回自动: 清空原始点基准与轨迹窗口，第一个GPS回调立即重新匹配吸附附近道路
      // (否则旧 lastRaw 会让回调永远命中抖动过滤，导致不生成新吸附点)
      state.lastRaw = null; state.rawWindow = [];
      state.candTm = 0; state.curPath = null; state.lastSnap = null; state.fusedBrg = null;
      state.pinned = false; state.pinnedPath = null; state.pinMiss = 0;
      updateSwitchBtn();
      // 吸附点立即切回自动主题色(蓝色)
      if (state.locMarker) state.locMarker.setContent('<div class="loc-dot"></div>');
      toast('已切换为自动定位(GPS)');
    }
  }

  function onManualPick(ll) {
    // 显示原始点击点(灰)
    if (!state.manualRawMarker) {
      state.manualRawMarker = new AMap.Marker({
        position: [ll.lng, ll.lat], offset: new AMap.Pixel(-8, -8), zIndex: 80,
        content: '<div class="raw-dot manual"></div>'
      });
      state.map.add(state.manualRawMarker);
      injectRawStyle();
    } else {
      state.manualRawMarker.setPosition([ll.lng, ll.lat]);
    }
    el.snapText.textContent = '正在吸附道路…';
    manualSnapByRoute(ll);
  }

  // 方案: 并行发起驾车+步行+骑行短距离规划，将点击点投影到所有返回折线，
  // 取距离最近的一条。步行/骑行规划覆盖辅路/非机动道/人行道，避免只能吸到机动车主路
  function manualSnapByRoute(ll) {
    const engines = enabledEngines();
    if (!engines.length) { manualSnapByRegeo(ll); return; }
    // 第一轮目标点向东~130m，未命中则重试向北~130m
    runSnapRound(ll, engines, [ll.lng + 0.0015, ll.lat], (best) => {
      if (best && best.dist <= CONFIG.manualSnapMaxDist) { applyManualSnap(ll, best); return; }
      runSnapRound(ll, engines, [ll.lng, ll.lat + 0.0012], (best2) => {
        if (best2 && best2.dist <= CONFIG.manualSnapMaxDist) applyManualSnap(ll, best2);
        else manualSnapByRegeo(ll);
      });
    });
  }

  // 对所有引擎发一轮规划，汇总取最近投影
  function runSnapRound(ll, engines, dest, done) {
    let pending = engines.length, best = null, called = false;
    const finish = () => { if (!called) { called = true; done(best); } };
    engines.forEach((eng) => {
      eng.search([ll.lng, ll.lat], dest, (status, result) => {
        if (!state.manualMode) { finish(); return; }
        if (status === 'complete' && result.routes && result.routes.length) {
          const path = collectRoutePath(result.routes[0]);
          if (path.length >= 2) {
            const prj = projectOnPath(ll, path);
            if (prj && (!best || prj.dist < best.dist)) best = prj;
          }
        }
        if (--pending === 0) finish();
      });
    });
  }

  // 提取路线折线: 驾车/步行用 steps，骑行用 rides
  function collectRoutePath(route) {
    const segs = route.steps || route.rides || [];
    const path = [];
    segs.forEach((s) => { (s.path || []).forEach((p) => path.push(p)); });
    return path;
  }

  function applyManualSnap(ll, prj) {
    if (!state.manualMode) return;
    commitCurrent({ lng: prj.point.lng, lat: prj.point.lat, snapped: true, accuracy: 0, manual: true });
    toastRoadName(prj.point, Math.round(prj.dist));
  }

  // 垂直投影: 求点到折线的最近投影点(局部平面近似，百米级误差可忽略)
  function projectOnPath(pt, path) {
    const rad = Math.PI / 180, R = 6378137, cosLat = Math.cos(pt.lat * rad);
    const toXY = (p) => {
      const lng = p.getLng ? p.getLng() : p.lng, lat = p.getLat ? p.getLat() : p.lat;
      return { x: (lng - pt.lng) * rad * cosLat * R, y: (lat - pt.lat) * rad * R };
    };
    let bestD = Infinity, bestX = 0, bestY = 0, bestI = 0;
    for (let i = 0; i < path.length - 1; i++) {
      const a = toXY(path[i]), b = toXY(path[i + 1]);
      const dx = b.x - a.x, dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      let t = len2 > 0 ? -(a.x * dx + a.y * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const px = a.x + t * dx, py = a.y + t * dy;
      const d = Math.sqrt(px * px + py * py);
      if (d < bestD) { bestD = d; bestX = px; bestY = py; bestI = i; }
    }
    if (bestD === Infinity) return null;
    const norm = (p) => ({ lng: p.getLng ? p.getLng() : p.lng, lat: p.getLat ? p.getLat() : p.lat });
    return {
      dist: bestD,
      segBrg: bearing(norm(path[bestI]), norm(path[bestI + 1])), // 投影段的道路方向角(行驶方向)
      point: { lng: pt.lng + bestX / (rad * cosLat * R), lat: pt.lat + bestY / (rad * R) }
    };
  }

  // 取道路名用于提示(异步，不影响吸附结果)
  function toastRoadName(pt, dist) {
    const suffix = '（偏移 ' + dist + 'm）';
    if (!state.geocoder) { toast('已吸附到最近道路' + suffix); return; }
    state.geocoder.getAddress([pt.lng, pt.lat], (status, result) => {
      if (status === 'complete' && result.regeocode && result.regeocode.roads && result.regeocode.roads.length) {
        toast('已吸附到「' + result.regeocode.roads[0].name + '」' + suffix);
      } else {
        toast('已吸附到最近道路' + suffix);
      }
    });
  }

  // 兜底: 逆地理 roads[0].location(道路锚点，精度低，仅兜底用)
  function manualSnapByRegeo(ll) {
    if (!state.geocoder) {
      commitCurrent({ lng: ll.lng, lat: ll.lat, snapped: false, accuracy: 0, manual: true });
      toast('无法吸附，使用点击位置');
      return;
    }
    state.geocoder.getAddress([ll.lng, ll.lat], (status, result) => {
      let road = null;
      if (status === 'complete' && result.regeocode && result.regeocode.roads && result.regeocode.roads.length) {
        road = result.regeocode.roads[0];
      }
      if (road && road.location) {
        const loc = road.location;
        const lng = loc.lng != null ? loc.lng : loc.getLng();
        const lat = loc.lat != null ? loc.lat : loc.getLat();
        if (distance(ll, { lng: lng, lat: lat }) <= CONFIG.manualSnapMaxDist) {
          commitCurrent({ lng: lng, lat: lat, snapped: true, accuracy: 0, manual: true });
          toast('已吸附到「' + (road.name || '最近道路') + '」(粗略)');
          return;
        }
      }
      commitCurrent({ lng: ll.lng, lat: ll.lat, snapped: false, accuracy: 0, manual: true });
      toast('附近未找到道路，使用点击位置');
    });
  }

  // ============================================================
  // 图层渲染(原始GPS点: 弱化色 / 吸附点: 鲜明色)
  // ============================================================
  function updateRawVisual(gcj, accuracy) {
    const pos = [gcj.lng, gcj.lat];
    if (!state.rawMarker) {
      state.rawMarker = new AMap.Marker({
        position: pos, offset: new AMap.Pixel(-9, -9), zIndex: 95,
        content: '<div class="raw-dot"></div>'
      });
      state.map.add(state.rawMarker);
      injectRawStyle();
    } else state.rawMarker.setPosition(pos);
    // 精度圈跟随原始点(手动模式/无精度时隐藏)
    if (accuracy && accuracy > 0 && !state.manualMode) {
      if (!state.accCircle) {
        state.accCircle = new AMap.Circle({
          center: pos, radius: accuracy,
          strokeColor: '#94a3b8', strokeOpacity: 0.35, strokeWeight: 1,
          fillColor: '#94a3b8', fillOpacity: 0.08, zIndex: 40
        });
        state.map.add(state.accCircle);
      } else {
        state.accCircle.setCenter(pos); state.accCircle.setRadius(accuracy);
      }
    } else if (state.accCircle) {
      state.map.remove(state.accCircle); state.accCircle = null;
    }
    fitBoth(); // 原始点位置变化 → 检测是否需要视野适配
  }

  function updateLocationVisual(pt, accuracy) {
    if (pt.snapped) {
      // 吸附成功 → 鲜明吸附点(自动=蓝色主题 / 手动=橙色主题)
      const pos = [pt.lng, pt.lat];
      const content = '<div class="loc-dot' + (state.manualMode ? ' manual' : '') + '"></div>';
      if (!state.locMarker) {
        state.locMarker = new AMap.Marker({
          position: pos, offset: new AMap.Pixel(-11, -11), zIndex: 100,
          content: content
        });
        state.map.add(state.locMarker);
        injectLocStyle();
      } else {
        state.locMarker.setPosition(pos);
        state.locMarker.setContent(content);
      }
    } else if (state.locMarker) {
      // 未吸附 → 隐藏吸附点，只显示原始点(此时原始点用鲜明色)
      state.map.remove(state.locMarker); state.locMarker = null;
    }
    // 只有原始点时切为鲜明色，否则弱化
    if (state.rawMarker) {
      const raw = state.rawMarker.getContentEl ? state.rawMarker.getContentEl() : state.rawMarker.dom;
      if (raw && raw.firstChild) {
        raw.firstChild.className = state.locMarker ? 'raw-dot' : 'raw-dot bright';
      }
    }
    fitBoth(); // 跟随模式下内部会强制适配，同时容纳原始点与吸附点
  }

  // 视野自适应适配: 先检测所有GPS点是否已在当前视野内，
  // 全部在视野内则不动，有点超出才重新适配(避免频繁抢占用户手动缩放);
  // force=true(定位按钮)或跟随模式下则强制适配，同时容纳原始点与吸附点
  function fitBoth(force) {
    if (state.manualMode) return;
    const arr = [];
    if (state.rawMarker) arr.push(state.rawMarker);
    if (state.locMarker) arr.push(state.locMarker);
    if (!arr.length) return;
    if (!force && !state.followMode) {
      const bounds = state.map.getBounds();
      const allIn = bounds && arr.every((m) => bounds.contains(m.getPosition()));
      if (allIn) return; // 全部在视野内 → 不做任何调整
    }
    state.map.setFitView(arr, true, [120, 60, 160, 60]);
    const z = state.map.getZoom();
    if (arr.length < 2) { if (z > 17) state.map.setZoom(17); } // 只有一个点: 避免过度放大
    else if (z > 19) state.map.setZoom(19); // 两点极近时避免放大过度
  }

  function injectLocStyle() {
    if (document.getElementById('locDotStyle')) return;
    const s = document.createElement('style'); s.id = 'locDotStyle';
    s.textContent = '.loc-dot{width:22px;height:22px;border-radius:50%;background:#2563eb;' +
      'border:3px solid #fff;box-shadow:0 0 0 2px rgba(37,99,235,.5),0 2px 6px rgba(0,0,0,.3);}' +
      // 手动模式主题(橙色)
      '.loc-dot.manual{background:#f97316;box-shadow:0 0 0 2px rgba(249,115,22,.5),0 2px 6px rgba(0,0,0,.3);}';
    document.head.appendChild(s);
  }
  function injectRawStyle() {
    if (document.getElementById('rawDotStyle')) return;
    const s = document.createElement('style'); s.id = 'rawDotStyle';
    // 弱化色原始点(有吸附点时); 无吸附点时切换为鲜明蓝; 手动点击点为弱化橙
    s.textContent = '.raw-dot{width:16px;height:16px;border-radius:50%;background:#94a3b8;' +
      'border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35);}' +
      '.raw-dot.bright{background:#2563eb;width:22px;height:22px;' +
      'box-shadow:0 0 0 2px rgba(37,99,235,.5),0 2px 6px rgba(0,0,0,.3);}' +
      '.raw-dot.manual{background:#fdba74;}';
    document.head.appendChild(s);
  }

  function renderCollected() {
    const linePath = state.collected.map((p) => [p.lng, p.lat]);
    if (linePath.length >= 2) {
      if (!state.trackLine) {
        state.trackLine = new AMap.Polyline({
          path: linePath, strokeColor: '#10b981', strokeWeight: 4, // 绿色虚线，与蓝色/橙色站点标记区分
          strokeOpacity: 0.9, strokeStyle: 'dashed', strokeDasharray: [10, 6],
          lineJoin: 'round', zIndex: 50
        });
        state.map.add(state.trackLine);
      } else state.trackLine.setPath(linePath);
    } else if (state.trackLine) {
      state.map.remove(state.trackLine); state.trackLine = null;
    }
    if (state.collectMarkers.length) { state.map.remove(state.collectMarkers); state.collectMarkers = []; }
    state.collected.forEach((p, i) => {
      // 站点标记按采集来源分色: 自动(gps)=蓝色系 / 手动(manual)=橙色系
      state.collectMarkers.push(new AMap.Marker({
        position: [p.lng, p.lat], offset: new AMap.Pixel(-9, -9), zIndex: 90,
        content: '<div class="cp-dot' + (p.source === 'manual' ? ' manual' : '') + '">' + (i + 1) + '</div>',
        title: p.name || ''
      }));
    });
    if (state.collectMarkers.length) state.map.add(state.collectMarkers);
    injectCpStyle();
    el.countText.textContent = state.collected.length;
  }
  function injectCpStyle() {
    if (document.getElementById('cpDotStyle')) return;
    const s = document.createElement('style'); s.id = 'cpDotStyle';
    s.textContent = '.cp-dot{min-width:18px;height:18px;padding:0 3px;border-radius:9px;background:#2563eb;' +
      'color:#fff;font-size:11px;font-weight:700;line-height:18px;text-align:center;' +
      'border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.3);}' +
      // 手动采集站点(橙色系)
      '.cp-dot.manual{background:#f97316;}';
    document.head.appendChild(s);
  }

  // ============================================================
  // 站点命名弹层 + POI 周边搜索
  // ============================================================
  function openNameModal() {
    if (!state.current) { toast('尚未获取到有效定位，可切换“手动”模式选点'); return; }
    const p = state.current;
    el.nmCoord.textContent = fmt(p.lng) + ', ' + fmt(p.lat);
    el.nmSnap.textContent = p.snapped ? (p.manual ? '手动吸附 ✓' : '路网吸附 ✓') : '未吸附';
    el.nmSnap.style.color = p.snapped ? '#10b981' : '#f59e0b';
    el.nameInput.value = '';
    el.nameModal.classList.remove('hidden');
    el.nameMask.classList.remove('hidden');
    queryPoiSuggestions(p);
  }

  function closeNameModal() {
    el.nameModal.classList.add('hidden');
    el.nameMask.classList.add('hidden');
    el.nameInput.blur();
  }

  function queryPoiSuggestions(center) {
    const token = ++state.poiToken;
    el.poiTip.textContent = '';
    el.poiList.innerHTML = '<div class="nm-loading">正在搜索周边地点…</div>';
    if (!POI_CATS[0]._search) {
      el.poiList.innerHTML = '<div class="nm-empty">POI 搜索不可用，请手动输入名称</div>';
      return;
    }
    const results = [];
    let pending = POI_CATS.length;
    const c = [center.lng, center.lat];
    POI_CATS.forEach((cat) => {
      cat._search.searchNearBy('', c, CONFIG.poiRadius, (status, result) => {
        if (token !== state.poiToken) return; // 已有更新的查询
        if (status === 'complete' && result.poiList && result.poiList.pois) {
          result.poiList.pois.slice(0, cat.limit).forEach((poi) => {
            results.push({
              name: poi.name,
              distance: (poi.distance != null && poi.distance !== '') ? Math.round(poi.distance) : null,
              icon: cat.icon, label: cat.label, first: !!cat.first
            });
          });
        }
        if (--pending === 0) finalizePoi(token, results);
      });
    });
  }

  function finalizePoi(token, results) {
    if (token !== state.poiToken) return;
    const seen = {};
    const uniq = results.filter((r) => { if (seen[r.name]) return false; seen[r.name] = 1; return true; });
    const byDist = (a, b) => (a.distance == null ? 9e9 : a.distance) - (b.distance == null ? 9e9 : b.distance);
    const bus = uniq.filter((r) => r.first).sort(byDist);
    const rest = uniq.filter((r) => !r.first).sort(byDist);
    const list = bus.concat(rest).slice(0, 12);
    renderPoiList(list);
  }

  function renderPoiList(list) {
    if (!list.length) {
      el.poiList.innerHTML = '<div class="nm-empty">周边暂无可识别地点，请手动输入名称</div>';
      return;
    }
    el.poiTip.textContent = '（点选填入，可再编辑）';
    el.poiList.innerHTML = list.map((r) =>
      '<div class="nm-poi-item" data-name="' + encodeURIComponent(r.name) + '">' +
        '<span class="poi-icon">' + r.icon + '</span>' +
        '<div class="poi-main">' +
          '<div class="poi-name">' + escapeHtml(r.name) + '</div>' +
          '<div class="poi-sub">' + r.label + (r.distance != null ? ' · ' + r.distance + 'm' : '') + '</div>' +
        '</div>' +
        '<span class="poi-tag">' + r.label + '</span>' +
      '</div>'
    ).join('');
    el.poiList.querySelectorAll('.nm-poi-item').forEach((item) => {
      item.addEventListener('click', () => {
        el.nameInput.value = decodeURIComponent(item.getAttribute('data-name'));
        el.poiList.querySelectorAll('.nm-poi-item').forEach((n) => n.classList.remove('picked'));
        item.classList.add('picked');
      });
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (m) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }

  // ============================================================
  // 采集 / 数据管理
  // ============================================================
  function saveRecord() {
    if (!state.current) { toast('无有效定位点'); return; }
    const p = state.current;
    const name = (el.nameInput.value || '').trim();
    const rec = {
      id: Date.now(),
      seq: state.collected.length + 1,
      name: name,
      lng: +fmt(p.lng), lat: +fmt(p.lat),
      snapped: !!p.snapped,
      source: p.manual ? 'manual' : 'gps',
      accuracy: Math.round(p.accuracy || 0),
      alt: state.lastAlt != null ? Math.round(state.lastAlt) : null,
      // 原始GPS坐标: 自动模式=芯片上报点; 手动模式=点击点本身
      raw: p.manual ? { lng: +fmt(p.lng), lat: +fmt(p.lat) }
        : (state.lastRaw ? { lng: +fmt(state.lastRaw.lng), lat: +fmt(state.lastRaw.lat) } : null),
      time: new Date().toISOString()
    };
    state.collected.push(rec);
    persist();
    renderCollected();
    vibrate(40);
    closeNameModal();
    toast('已采集 #' + rec.seq + (name ? ' ' + name : '') + (rec.snapped ? '（已吸附）' : '（未吸附）'));
  }

  function undo() {
    if (!state.collected.length) { toast('没有可撤销的点'); return; }
    const last = state.collected[state.collected.length - 1];
    if (!confirm('确定撤销上一个采集点 #' + last.seq + (last.name ? ' ' + last.name : '') + ' ？')) return;
    state.collected.pop(); persist(); renderCollected(); toast('已撤销上一个点');
  }
  function clearAll() {
    if (!state.collected.length) { toast('列表已为空'); return; }
    if (!confirm('确定清空全部 ' + state.collected.length + ' 个采集点？')) return;
    state.collected = []; persist(); renderCollected(); toast('已清空');
  }
  function deleteOne(id) {
    state.collected = state.collected.filter((p) => p.id !== id);
    state.collected.forEach((p, i) => (p.seq = i + 1));
    persist(); renderCollected(); renderList();
  }
  function persist() {
    try { localStorage.setItem(CONFIG.storeKey, JSON.stringify(state.collected)); } catch (e) {}
  }
  function restore() {
    try {
      const raw = localStorage.getItem(CONFIG.storeKey);
      if (raw) { state.collected = JSON.parse(raw) || []; renderCollected(); }
    } catch (e) { state.collected = []; }
  }

  // ---------------- 导出 ----------------
  function download(filename, content, mime) {
    const blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function csvCell(v) {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function exportCsv() {
    if (!state.collected.length) { toast('无数据可导出'); return; }
    // 同时记录原始GPS坐标与吸附后坐标; 未吸附时吸附列留空
    const head = 'seq,name,raw_lng,raw_lat,snap_lng,snap_lat,snapped,source,accuracy_m,alt_m,time\n';
    const rows = state.collected.map((p) => {
      const raw = p.raw ? p.raw : { lng: p.lng, lat: p.lat }; // 老数据无 raw 字段时回退主坐标
      const rawLng = raw.lng != null ? raw.lng : '';
      const rawLat = raw.lat != null ? raw.lat : '';
      const snapLng = p.snapped ? p.lng : '';
      const snapLat = p.snapped ? p.lat : '';
      return [p.seq, csvCell(p.name), rawLng, rawLat, snapLng, snapLat,
        p.snapped ? 1 : 0, p.source || 'gps', p.accuracy, p.alt == null ? '' : p.alt, p.time].join(',');
    }).join('\n');
    download('points_' + Date.now() + '.csv', '\ufeff' + head + rows, 'text/csv;charset=utf-8');
    toast('CSV 已导出');
  }

  // ---------------- 列表 ----------------
  function renderList() {
    if (!state.collected.length) {
      el.listBody.innerHTML = '<div class="list-empty">暂无采集点</div>'; return;
    }
    el.listBody.innerHTML = state.collected.map((p) =>
      '<div class="list-item">' +
        '<span class="idx">' + p.seq + '</span>' +
        '<div class="meta">' +
          '<div class="c">' + (p.name ? escapeHtml(p.name) + ' · ' : '') + p.lng + ', ' + p.lat +
            (p.snapped ? '' : ' <span style="color:#f59e0b">(未吸附)</span>') + '</div>' +
          '<div class="t">' + (p.source === 'manual' ? '手动 · ' : 'GPS±' + p.accuracy + 'm · ') +
            new Date(p.time).toLocaleString() + '</div>' +
        '</div>' +
        '<button class="del" data-id="' + p.id + '">删除</button>' +
      '</div>'
    ).join('');
    el.listBody.querySelectorAll('.del').forEach((b) => {
      b.addEventListener('click', () => deleteOne(+b.getAttribute('data-id')));
    });
  }

  // ============================================================
  // 屏幕常亮
  // ============================================================
  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try { state.wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
    document.addEventListener('visibilitychange', async () => {
      if (state.wakeLock !== null && document.visibilityState === 'visible') {
        try { state.wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
      }
    });
  }

  // ============================================================
  // UI 事件
  // ============================================================
  function toggleSheet(show) {
    el.sheet.classList.toggle('hidden', !show);
    el.mask.classList.toggle('hidden', !show);
  }

  function openLvlModal() {
    el.lvlModal.classList.remove('hidden');
    el.lvlMask.classList.remove('hidden');
  }
  function closeLvlModal() {
    el.lvlModal.classList.add('hidden');
    el.lvlMask.classList.add('hidden');
  }

  function bindUI() {
    el.btnCollect.addEventListener('click', openNameModal);
    el.btnLayer.addEventListener('click', toggleSatellite);
    el.modeAuto.addEventListener('click', () => { if (state.manualMode) toggleManual(); });
    el.modeManual.addEventListener('click', () => { if (!state.manualMode) toggleManual(); });

    el.btnLocate.addEventListener('click', () => {
      state.followMode = true;
      fitBoth(true); // 强制适配: 原始GPS点与吸附点同时放入视野
      toast('已开启位置跟随(视野同时包含原始点与吸附点)');
    });

    el.btnMenu.addEventListener('click', () => toggleSheet(true));
    el.mask.addEventListener('click', () => toggleSheet(false));
    el.btnCloseSheet.addEventListener('click', () => toggleSheet(false));
    el.btnExportCsv.addEventListener('click', () => { exportCsv(); toggleSheet(false); });
    el.btnRoadLevel.addEventListener('click', () => { toggleSheet(false); openLvlModal(); });
    el.lvlMask.addEventListener('click', closeLvlModal);
    el.lvlClose.addEventListener('click', closeLvlModal);
    el.btnUndo.addEventListener('click', () => { toggleSheet(false); undo(); });
    el.btnClear.addEventListener('click', () => { toggleSheet(false); clearAll(); });
    el.btnRoadSwitch.addEventListener('click', onRoadSwitch);
    el.btnList.addEventListener('click', () => { renderList(); el.listPanel.classList.remove('hidden'); toggleSheet(false); });
    el.btnCloseList.addEventListener('click', () => el.listPanel.classList.add('hidden'));

    // 命名弹层
    el.nmCancel.addEventListener('click', closeNameModal);
    el.nameMask.addEventListener('click', closeNameModal);
    el.nmConfirm.addEventListener('click', saveRecord);
    el.nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveRecord(); });

    // 道路等级勾选
    (el.lvlCbs || []).forEach((cb) => cb.addEventListener('change', onLevelChange));
  }

  function boot() { bindUI(); initMap(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
