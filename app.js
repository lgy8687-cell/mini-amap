/**
 * 极简地图 - 高德风格 UI 重写
 */

(function () {
  'use strict';

  if ('serviceWorker' in navigator) {
    var cacheVersion = window.MINI_AMAP_VERSION || 'v1';
    navigator.serviceWorker.register('/mini-amap/sw.js?v=' + encodeURIComponent(cacheVersion)).catch(function () {});
  }

  // ===== 状态 =====
  var map = null;
  var key = localStorage.getItem('amap_key') || '';
  var securityCode = localStorage.getItem('amap_security') || '';
  var currentLocation = null;     // LngLat
  var currentCity = '';
  var searchMarkers = [];
  var routePolylines = [];
  var routeLabels = [];
  var allRouteData = [];
  var selectedRouteIndex = 0;
  var autocompleteTimer = null;
  var trafficLayer = null;
  var trafficVisible = true;
  var quickDestinationButtons = document.querySelectorAll('.driver-shortcut');
  var quickDestinationFallbacks = {
    '福州站': [119.3133, 26.1158],
    '福州南站': [119.3852, 25.9916],
  };
  var overviewPolylines = [];
  var overviewTimer = null;
  var overviewRequest = null;
  var overviewTileCache = new Map();
  var overviewEndpoint = window.MINI_AMAP_TRAFFIC_API || '';
  // 12 级及以下补城区中心线；更大范围仍交给原生路况，避免耗尽 Web 服务查询额度。
  var OVERVIEW_MAX_ZOOM = 12;
  var OVERVIEW_TILE_DEGREES = 0.06;
  var OVERVIEW_MAX_TILES = 36;
  var OVERVIEW_CACHE_MS = 300000;
  var TRAFFIC_REFRESH_MS = 300000;

  // 路线规划状态
  var routeEnd = null;            // { pos: LngLat, name: string }
  var routeStart = null;          // { pos: LngLat, name: string }
  var currentMode = 'driving';    // driving | transit | walking | riding

  // ===== DOM =====
  var homeSearch = document.getElementById('home-search');
  var searchPage = document.getElementById('search-page');
  var searchBack = document.getElementById('search-back');
  var searchInput = document.getElementById('search-input');
  var searchClearInput = document.getElementById('search-clear-input');
  var searchBody = document.getElementById('search-body');
  var routePage = document.getElementById('route-page');
  var routeBack = document.getElementById('route-back');
  var routeStartText = document.getElementById('route-start-text');
  var routeEndText = document.getElementById('route-end-text');
  var swapBtn = document.getElementById('swap-btn');
  var routeModeLabels = document.querySelectorAll('.route-mode');
  var routeBottom = document.getElementById('route-bottom');
  var routeLoading = document.getElementById('route-loading');
  var routeCardsEl = document.getElementById('route-cards');
  var locateBtn = document.getElementById('locate-btn');
  var trafficBtn = document.getElementById('traffic-btn');
  var settingsBtn = document.getElementById('settings-btn');
  var trafficFocusHint = document.getElementById('traffic-focus-hint');
  var keyModal = document.getElementById('key-modal');
  var keyInput = document.getElementById('key-input');
  var securityInput = document.getElementById('security-input');
  var saveKey = document.getElementById('save-key');
  var keyError = document.getElementById('key-error');

  // ===== 工具 =====
  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatTime(seconds) {
    var mins = Math.ceil(seconds / 60);
    var h = Math.floor(mins / 60);
    var m = mins % 60;
    if (h > 0) return h + '小时' + (m > 0 ? m + '分' : '');
    return m + '分钟';
  }

  function formatDistance(meters) {
    if (meters >= 1000) return (meters / 1000).toFixed(1) + '公里';
    return Math.round(meters) + '米';
  }

  // ===== 页面切换 =====
  function showSearchPage() {
    searchPage.classList.remove('hidden');
    searchInput.focus();
    // 空输入显示历史
    if (!searchInput.value.trim()) {
      renderHistory();
    }
  }

  function hideSearchPage() {
    searchPage.classList.add('hidden');
    searchInput.blur();
  }

  function showRoutePage() {
    routePage.classList.remove('hidden');
  }

  function hideRoutePage() {
    routePage.classList.add('hidden');
    clearRouteDisplay();
  }

  // ===== 搜索历史 =====
  var HISTORY_KEY = 'mini-amap-history';
  var MAX_HISTORY = 5;

  function getSearchHistory() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; }
    catch (e) { return []; }
  }

  function addSearchHistory(keyword) {
    if (!keyword || !keyword.trim()) return;
    var list = getSearchHistory();
    var idx = list.indexOf(keyword);
    if (idx >= 0) list.splice(idx, 1);
    list.unshift(keyword);
    if (list.length > MAX_HISTORY) list = list.slice(0, MAX_HISTORY);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
  }

  function clearSearchHistory() {
    localStorage.removeItem(HISTORY_KEY);
    renderHistory();
  }

  // ===== 搜索页面内容渲染 =====

  // 渲染搜索历史（tag 样式）
  function renderHistory() {
    var list = getSearchHistory();
    if (list.length === 0) {
      searchBody.innerHTML = '<div class="history-empty">暂无搜索记录</div>';
      return;
    }
    var html = '<div class="history-section">' +
      '<div class="history-header">' +
      '<span class="history-title">搜索历史</span>' +
      '<button class="history-clear" id="clear-history-btn">清空</button>' +
      '</div>' +
      '<div class="history-tags">';
    list.forEach(function (kw) {
      html += '<span class="history-tag" data-keyword="' + escapeHtml(kw) + '">' + escapeHtml(kw) + '</span>';
    });
    html += '</div></div>';
    searchBody.innerHTML = html;

    // 绑定清空
    var clearBtn = document.getElementById('clear-history-btn');
    if (clearBtn) {
      clearBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        clearSearchHistory();
      });
    }
    // 绑定点击历史 tag → 搜索
    searchBody.querySelectorAll('.history-tag').forEach(function (tag) {
      tag.addEventListener('click', function () {
        var kw = tag.getAttribute('data-keyword');
        searchInput.value = kw;
        doSearch(kw);
      });
    });
  }

  // 渲染自动补全提示
  function renderSuggestions(tips) {
    var html = '';
    tips.forEach(function (tip) {
      var addr = (tip.district || '') + (tip.address || '');
      html += '<div class="suggest-item" data-lng="' + tip.location.lng + '" data-lat="' + tip.location.lat + '" data-name="' + escapeHtml(tip.name) + '" data-addr="' + escapeHtml(addr) + '">' +
        '<span class="suggest-icon">📍</span>' +
        '<div class="suggest-info">' +
        '<div class="suggest-name">' + escapeHtml(tip.name) + '</div>' +
        '<div class="suggest-addr">' + escapeHtml(addr || '') + '</div>' +
        '</div></div>';
    });
    searchBody.innerHTML = html;

    // 点击提示 → 设置终点并打开路线规划页
    searchBody.querySelectorAll('.suggest-item').forEach(function (item) {
      item.addEventListener('click', function () {
        var lng = parseFloat(item.getAttribute('data-lng'));
        var lat = parseFloat(item.getAttribute('data-lat'));
        var name = item.getAttribute('data-name');
        addSearchHistory(name);
        setRouteDestination(new AMap.LngLat(lng, lat), name);
        hideSearchPage();
      });
    });
  }

  // 渲染搜索结果
  function renderSearchResults(pois) {
    var html = '';
    pois.forEach(function (poi) {
      var addr = (poi.pname || '') + (poi.cityname || '') + (poi.adname || '') + (poi.address || '');
      html += '<div class="result-item" data-lng="' + poi.location.lng + '" data-lat="' + poi.location.lat + '" data-name="' + escapeHtml(poi.name) + '">' +
        '<div class="result-name">' + escapeHtml(poi.name) + '</div>' +
        '<div class="result-addr">' + escapeHtml(addr || '暂无地址信息') + '</div>' +
        '</div>';
    });
    searchBody.innerHTML = html;

    // 点击结果 → 设置终点并打开路线规划页
    searchBody.querySelectorAll('.result-item').forEach(function (item) {
      item.addEventListener('click', function () {
        var lng = parseFloat(item.getAttribute('data-lng'));
        var lat = parseFloat(item.getAttribute('data-lat'));
        var name = item.getAttribute('data-name');
        addSearchHistory(name);
        clearSearchMarkers();
        setRouteDestination(new AMap.LngLat(lng, lat), name);
        hideSearchPage();
      });
    });
  }

  // ===== 设置路线终点，打开路线规划页 =====
  function setRouteDestination(pos, name) {
    routeEnd = { pos: pos, name: name };
    routeStartText.textContent = '我的位置';
    routeEndText.textContent = name;
    showRoutePage();
    doRoutePlan();
  }

  // 常用目的地走一次 POI 搜索，避免将车站坐标写死后与高德数据脱节。
  function openQuickDestination(keyword, displayName) {
    if (!map) {
      setTrafficHint('地图正在加载，请稍后再试');
      return;
    }

    routeStartText.textContent = '正在获取当前位置';
    routeEndText.textContent = displayName;
    routeLoading.style.display = 'block';
    routeLoading.textContent = '正在查询' + displayName + '路线...';
    routeCardsEl.innerHTML = '';
    showRoutePage();

    var placeSearch = new AMap.PlaceSearch({
      city: '福州',
      citylimit: true,
      pageSize: 5,
    });

    placeSearch.search(keyword, function (status, result) {
      if (status === 'complete' && result.poiList && result.poiList.pois.length) {
        var poi = result.poiList.pois[0];
        routeLoading.textContent = '正在规划路线...';
        setRouteDestination(new AMap.LngLat(poi.location.lng, poi.location.lat), displayName || poi.name);
        return;
      }

      var fallback = quickDestinationFallbacks[displayName];
      if (fallback) {
        routeLoading.textContent = '正在规划路线...';
        setRouteDestination(new AMap.LngLat(fallback[0], fallback[1]), displayName);
      } else {
        routeLoading.textContent = '没有找到' + displayName + '，请稍后重试';
      }
    });
  }

  // 页面按钮的直接入口，避免移动端事件绑定或旧缓存导致点击无响应。
  window.miniAmapOpenStation = function (button) {
    openQuickDestination(
      button.getAttribute('data-destination'),
      button.getAttribute('data-display-name')
    );
  };

  // ===== 缩小时的城区路况概览 =====
  // 原生路况瓦片在缩小时会省略不少支路。接入中转服务后，用道路中心线补齐概览层。
  function clearOverviewTraffic() {
    overviewPolylines.forEach(function (line) { line.setMap(null); });
    overviewPolylines = [];
  }

  function setTrafficHint(text) {
    if (trafficFocusHint) trafficFocusHint.textContent = text;
  }

  function scheduleOverviewTraffic() {
    if (!overviewEndpoint || !map) return;
    if (map.getZoom() > OVERVIEW_MAX_ZOOM) {
      clearOverviewTraffic();
      setTrafficHint('红色 = 拥堵');
      return;
    }

    if (overviewTimer) clearTimeout(overviewTimer);
    overviewTimer = setTimeout(loadOverviewTraffic, 250);
  }

  function splitOverviewBounds() {
    var bounds = map.getBounds();
    var southWest = bounds.getSouthWest();
    var northEast = bounds.getNorthEast();
    var tiles = [];

    // 高德矩形交通态势单次适合小范围查询，拆成约 5 公里的网格再合并。
    for (var west = southWest.lng; west < northEast.lng; west += OVERVIEW_TILE_DEGREES) {
      for (var south = southWest.lat; south < northEast.lat; south += OVERVIEW_TILE_DEGREES) {
        tiles.push({
          west: west,
          south: south,
          east: Math.min(west + OVERVIEW_TILE_DEGREES, northEast.lng),
          north: Math.min(south + OVERVIEW_TILE_DEGREES, northEast.lat),
        });
      }
    }
    return tiles;
  }

  function normalizeOverviewRoad(road) {
    var points = String(road.polyline || '').split(';').map(function (point) {
      return point.split(',').map(Number);
    }).filter(function (point) {
      return Number.isFinite(point[0]) && Number.isFinite(point[1]);
    });

    if (points.length < 2) return null;
    return {
      name: road.name || '',
      status: road.status || '未知',
      direction: road.direction || '',
      points: points,
    };
  }

  async function loadOverviewTile(tile, controller) {
    var rectangle = [tile.west, tile.south, tile.east, tile.north].join(',');
    var cached = overviewTileCache.get(rectangle);
    if (cached && cached.expiresAt > Date.now()) return cached.roads;

    var url = new URL(overviewEndpoint);
    url.searchParams.set('rectangle', tile.west + ',' + tile.south + ';' + tile.east + ',' + tile.north);
    url.searchParams.set('level', '6');
    url.searchParams.set('extensions', 'all');
    var response = await fetch(url.toString(), { signal: controller.signal });
    if (!response.ok) throw new Error('Traffic request failed');
    var payload = await response.json();
    if (payload.status !== '1') throw new Error(payload.info || 'Traffic request failed');

    var roads = (payload.trafficinfo && payload.trafficinfo.roads ? payload.trafficinfo.roads : [])
      .map(normalizeOverviewRoad)
      .filter(Boolean);
    overviewTileCache.set(rectangle, { roads: roads, expiresAt: Date.now() + OVERVIEW_CACHE_MS });
    return roads;
  }

  function overviewStyle(status) {
    if (status === '严重拥堵') return { color: '#B71C1C', weight: 8 };
    if (status === '拥堵') return { color: '#F44336', weight: 7 };
    if (status === '缓行') return { color: '#FF9800', weight: 6 };
    return { color: '#18A058', weight: 5 };
  }

  function getOverviewErrorHint(error) {
    var message = String(error && error.message || '');
    if (/USER_KEY|KEY|key/i.test(message)) return '当前 Key 不支持路况概览';
    if (/AREA|large/i.test(message)) return '地图放大一点，可显示城区单线路况';
    return '城区路况暂时加载失败';
  }

  async function loadOverviewTraffic() {
    if (!overviewEndpoint || !map || map.getZoom() > OVERVIEW_MAX_ZOOM) return;
    if (!key) return;
    if (overviewRequest) overviewRequest.abort();

    var controller = new AbortController();
    overviewRequest = controller;
    var tiles = splitOverviewBounds();
    if (tiles.length > OVERVIEW_MAX_TILES) {
      clearOverviewTraffic();
      setTrafficHint('地图放大一点，可显示城区单线路况');
      overviewRequest = null;
      return;
    }
    setTrafficHint('正在加载城区路况');
    try {
      var chunks = await Promise.all(tiles.map(function (tile) {
        return loadOverviewTile(tile, controller);
      }));
      var seen = new Set();
      var roads = chunks.flat().filter(function (road) {
        var first = road.points[0];
        var last = road.points[road.points.length - 1];
        var id = road.name + '|' + road.direction + '|' + first.join(',') + '|' + last.join(',');
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });

      clearOverviewTraffic();
      roads.forEach(function (road) {
        if (!Array.isArray(road.points) || road.points.length < 2) return;
        var style = overviewStyle(road.status);
        var line = new AMap.Polyline({
          path: road.points,
          strokeColor: style.color,
          strokeWeight: style.weight,
          strokeOpacity: 0.95,
          lineJoin: 'round',
          lineCap: 'round',
          zIndex: 140,
        });
        map.add(line);
        overviewPolylines.push(line);
      });
      setTrafficHint('缩小概览：红色 = 拥堵');
    } catch (error) {
      if (error.name !== 'AbortError') setTrafficHint(getOverviewErrorHint(error));
    } finally {
      if (overviewRequest === controller) overviewRequest = null;
    }
  }

  // ===== 加载地图 =====
  function loadMap() {
    if (window.AMap) { initMap(); return; }
    if (!key) { keyModal.classList.remove('hidden'); return; }
    if (securityCode) {
      window._AMapSecurityConfig = { securityJsCode: securityCode };
    }
    var s = document.createElement('script');
    s.src = 'https://webapi.amap.com/maps?v=2.0&key=' + key + '&plugin=AMap.Geolocation,AMap.PlaceSearch,AMap.AutoComplete,AMap.Geocoder,AMap.Driving,AMap.Transfer,AMap.Walking,AMap.Riding';
    s.onload = function () {
      if (window.AMap && window.AMap.Map) {
        initMap();
      } else {
        keyError.textContent = 'Key 无效，请检查后重新输入';
        keyModal.classList.remove('hidden');
      }
    };
    s.onerror = function () {
      keyError.textContent = '地图加载失败，请检查Key';
      keyModal.classList.remove('hidden');
    };
    document.head.appendChild(s);
  }

  function initMap() {
    map = new AMap.Map('map-container', {
      // 城区全貌仍能看清红黄绿主干道，避免缩得太小后路况变成细线。
      zoom: 12,
      center: [116.397428, 39.90923],
      zooms: [10, 20],
      // 去掉普通道路的颜色干扰，让实时路况成为第一视觉层。
      mapStyle: 'amap://styles/whitesmoke',
      resizeEnable: true,
    });

    // 默认开启实时路况图层
    trafficLayer = new AMap.TileLayer.Traffic({
      // 路况在规划路线之上：蓝线不能遮住红色拥堵段。
      zIndex: 120,
      autoRefresh: true,
      interval: 120,
    });
    trafficLayer.setMap(map);
    trafficVisible = true;

    doLocate();

    // 10 级是看福州城区路况仍有辨识度的下限。
    map.on('zoomend', function () {
      if (map.getZoom() < 10) map.setZoom(10);
      scheduleOverviewTraffic();
    });
    map.on('moveend', scheduleOverviewTraffic);

    // 点击地图：逆地理编码 + 信息窗口
    map.on('click', function (e) {
      reverseGeocode(e.lnglat);
    });
  }

  // ===== 定位 =====
  function doLocate(callback) {
    if (!map) {
      if (callback) callback(false);
      return;
    }
    var geo = new AMap.Geolocation({ enableHighAccuracy: true, timeout: 10000 });
    geo.getCurrentPosition(function (status, result) {
      if (status === 'complete') {
        currentLocation = result.position;
        map.setCenter(result.position);
        updateCurrentCity(result.position);
        if (callback) callback(true);
      } else if (callback) {
        callback(false);
      }
    });
  }

  // ===== 更新当前城市 =====
  function updateCurrentCity(lnglat) {
    var geocoder = new AMap.Geocoder();
    geocoder.getAddress(lnglat, function (status, result) {
      if (status === 'complete' && result.regeocode && result.regeocode.addressComponent) {
        var comp = result.regeocode.addressComponent;
        if (comp.city && comp.city.length > 0) {
          currentCity = comp.city;
        } else if (comp.province && comp.province.length > 0) {
          currentCity = comp.province;
        }
      }
    });
  }

  // ===== 逆地理编码 =====
  function reverseGeocode(lnglat) {
    var geocoder = new AMap.Geocoder();
    geocoder.getAddress(lnglat, function (status, result) {
      if (status === 'complete' && result.regeocode) {
        var addr = result.regeocode.formattedAddress;
        showInfoWindow(lnglat, addr);
      }
    });
  }

  // ===== 信息窗口 =====
  function showInfoWindow(lnglat, title) {
    var safeTitle = escapeHtml(title);
    var content = '<div class="info-window">' +
      '<div class="iw-title">' + safeTitle + '</div>' +
      '<div class="iw-actions">' +
      '<button class="iw-btn" onclick="window._navFrom(this)" data-lng="' + lnglat.lng + '" data-lat="' + lnglat.lat + '" data-name="' + safeTitle + '">导航到这里</button>' +
      '</div></div>';
    var infoWindow = new AMap.InfoWindow({ content: content, offset: new AMap.Pixel(0, -36) });
    infoWindow.open(map, lnglat);
  }

  // 导航到这里 → 打开路线规划
  window._navFrom = function (btn) {
    var lng = parseFloat(btn.getAttribute('data-lng'));
    var lat = parseFloat(btn.getAttribute('data-lat'));
    var name = btn.getAttribute('data-name');
    setRouteDestination(new AMap.LngLat(lng, lat), name);
  };

  function clearSearchMarkers() {
    searchMarkers.forEach(function (m) { m.setMap(null); });
    searchMarkers = [];
  }

  // ===== 自动补全（输入时实时提示） =====
  function showAutocomplete(keyword) {
    if (!map) return;
    var autoComplete = new AMap.AutoComplete({
      city: currentCity || '全国',
      citylimit: false,
    });
    autoComplete.search(keyword, function (status, result) {
      if (status === 'complete' && result.tips && result.tips.length > 0) {
        var tips = result.tips.filter(function (t) { return t.location && t.location.lng; });
        if (tips.length === 0) {
          searchBody.innerHTML = '<div class="history-empty">无匹配结果</div>';
          return;
        }
        renderSuggestions(tips.slice(0, 10));
      } else {
        searchBody.innerHTML = '<div class="history-empty">无匹配结果</div>';
      }
    });
  }

  // ===== 搜索（PlaceSearch） =====
  function doSearch(keyword) {
    if (!keyword || !keyword.trim()) return;
    if (!map) {
      searchBody.innerHTML = '<div class="history-empty">地图未加载，请先配置Key</div>';
      return;
    }
    addSearchHistory(keyword.trim());

    var searchCity = currentCity || '全国';
    var placeSearch = new AMap.PlaceSearch({
      pageSize: 10,
      pageIndex: 1,
      city: searchCity,
      citylimit: false,
    });

    placeSearch.search(keyword, function (status, result) {
      if (status === 'complete' && result.poiList && result.poiList.pois && result.poiList.pois.length > 0) {
        var pois = result.poiList.pois;

        // 城市优先排序
        var myCity = currentCity || '';
        var myCityName = myCity.replace(/市$/, '');
        var myProvince = myCityName;
        var cityToProvince = {
          '广州': '广东', '深圳': '广东', '东莞': '广东', '佛山': '广东',
          '珠海': '广东', '惠州': '广东', '中山': '广东', '汕头': '广东',
          '杭州': '浙江', '宁波': '浙江', '温州': '浙江',
          '南京': '江苏', '苏州': '江苏', '无锡': '江苏', '常州': '江苏',
          '成都': '四川', '武汉': '湖北', '长沙': '湖南', '郑州': '河南',
          '西安': '陕西', '济南': '山东', '青岛': '山东',
          '合肥': '安徽', '福州': '福建', '厦门': '福建',
          '昆明': '云南', '贵阳': '贵州', '南宁': '广西',
          '太原': '山西', '石家庄': '河北', '南昌': '江西',
          '哈尔滨': '黑龙江', '长春': '吉林', '沈阳': '辽宁',
          '兰州': '甘肃', '呼和浩特': '内蒙古', '乌鲁木齐': '新疆',
          '拉萨': '西藏', '银川': '宁夏', '西宁': '青海', '海口': '海南',
        };
        if (cityToProvince[myCityName]) myProvince = cityToProvince[myCityName];

        pois.sort(function (a, b) {
          var aScore = 0, bScore = 0;
          if (myCityName) {
            if ((a.cityname || '').indexOf(myCityName) >= 0) aScore += 3;
            if ((b.cityname || '').indexOf(myCityName) >= 0) bScore += 3;
          }
          if (myProvince && myProvince !== myCityName) {
            if ((a.pname || '').indexOf(myProvince) >= 0) aScore += 1;
            if ((b.pname || '').indexOf(myProvince) >= 0) bScore += 1;
          }
          if (myCityName && myProvince === myCityName) {
            if ((a.pname || '').indexOf(myCityName) >= 0) aScore += 1;
            if ((b.pname || '').indexOf(myCityName) >= 0) bScore += 1;
          }
          return bScore - aScore;
        });

        renderSearchResults(pois.slice(0, 10));

        // 添加地图标记
        clearSearchMarkers();
        pois.slice(0, 10).forEach(function (poi, i) {
          var marker = new AMap.Marker({
            position: [poi.location.lng, poi.location.lat],
            title: poi.name,
            label: { content: '' + (i + 1), direction: 'top' },
          });
          marker.on('click', function () {
            showInfoWindow(new AMap.LngLat(poi.location.lng, poi.location.lat), poi.name);
          });
          searchMarkers.push(marker);
        });
        map.add(searchMarkers);
        if (searchMarkers.length > 0) {
          map.setFitView(searchMarkers, false, [60, 60, 60, 120]);
        }
      } else {
        searchBody.innerHTML = '<div class="history-empty">未找到相关地点</div>';
      }
    });
  }

  // ===== 路线规划 =====
  function doRoutePlan() {
    if (!map) return;
    if (!routeEnd) return;

    var startPos = currentLocation;
    if (!startPos) {
      routeLoading.style.display = 'block';
      routeLoading.textContent = '正在获取当前位置，请允许定位';
      routeCardsEl.innerHTML = '';
      doLocate(function (located) {
        if (located) {
          doRoutePlan();
        } else {
          routeLoading.textContent = '无法获取当前位置，请点右侧定位按钮后重试';
        }
      });
      return;
    }

    routeStart = { pos: startPos, name: '我的位置' };
    clearRouteDisplay();
    routeLoading.style.display = 'block';
    routeCardsEl.innerHTML = '';

    var endPos = routeEnd.pos;

    switch (currentMode) {
      case 'driving':
        planDriving(startPos, endPos);
        break;
      case 'transit':
        planTransit(startPos, endPos);
        break;
      case 'walking':
        planWalking(startPos, endPos);
        break;
      case 'riding':
        planRiding(startPos, endPos);
        break;
    }
  }

  // --- 驾车 ---
  function planDriving(startPos, endPos) {
    var driving = new AMap.Driving({ policy: 10, hideMarkers: true });
    driving.search(startPos, endPos, function (status, result) {
      routeLoading.style.display = 'none';
      if (status === 'complete' && result.routes && result.routes.length > 0) {
        var routes = result.routes;
        var policyTags = ['推荐', '备选一', '备选二'];
        routes.forEach(function (route, idx) {
          var tag = idx < policyTags.length ? policyTags[idx] : '备选' + (idx + 1);
          allRouteData.push({ index: idx, route: route, policy: { tag: tag }, mode: 'driving' });
        });
        allRouteData.sort(function (a, b) { return a.route.time - b.route.time; });
        selectedRouteIndex = 0;
        drawRoutes();
        renderRouteCards();
        addEndpointMarkers(startPos, endPos);
      } else {
        // 降级策略 0
        var fb = new AMap.Driving({ policy: 0, hideMarkers: true });
        fb.search(startPos, endPos, function (s2, r2) {
          if (s2 === 'complete' && r2.routes && r2.routes.length > 0) {
            allRouteData.push({ index: 0, route: r2.routes[0], policy: { tag: '推荐' }, mode: 'driving' });
            selectedRouteIndex = 0;
            drawRoutes();
            renderRouteCards();
            addEndpointMarkers(startPos, endPos);
          } else {
            routeCardsEl.innerHTML = '<div class="route-loading">未找到驾车路线</div>';
          }
        });
      }
    });
  }

  // --- 公交 ---
  function planTransit(startPos, endPos) {
    var transfer = new AMap.Transfer({
      city: currentCity || '北京',
      policy: AMap.TransferPolicy.LEAST_TIME,
      hideMarkers: true,
    });
    transfer.search(startPos, endPos, function (status, result) {
      routeLoading.style.display = 'none';
      if (status === 'complete' && result.plans && result.plans.length > 0) {
        result.plans.forEach(function (plan, idx) {
          var tag = idx === 0 ? '推荐' : '备选' + idx;
          allRouteData.push({ index: idx, route: plan, policy: { tag: tag }, mode: 'transit' });
        });
        selectedRouteIndex = 0;
        drawTransitRoutes();
        renderRouteCards();
        addEndpointMarkers(startPos, endPos);
      } else {
        routeCardsEl.innerHTML = '<div class="route-loading">未找到公交路线</div>';
      }
    });
  }

  // --- 步行 ---
  function planWalking(startPos, endPos) {
    var walking = new AMap.Walking({ hideMarkers: true });
    walking.search(startPos, endPos, function (status, result) {
      routeLoading.style.display = 'none';
      if (status === 'complete' && result.routes && result.routes.length > 0) {
        result.routes.forEach(function (route, idx) {
          var tag = idx === 0 ? '推荐' : '备选' + idx;
          allRouteData.push({ index: idx, route: route, policy: { tag: tag }, mode: 'walking' });
        });
        selectedRouteIndex = 0;
        drawRoutes();
        renderRouteCards();
        addEndpointMarkers(startPos, endPos);
      } else {
        routeCardsEl.innerHTML = '<div class="route-loading">未找到步行路线</div>';
      }
    });
  }

  // --- 骑行 ---
  function planRiding(startPos, endPos) {
    var riding = new AMap.Riding({ hideMarkers: true });
    riding.search(startPos, endPos, function (status, result) {
      routeLoading.style.display = 'none';
      if (status === 'complete' && result.routes && result.routes.length > 0) {
        result.routes.forEach(function (route, idx) {
          var tag = idx === 0 ? '推荐' : '备选' + idx;
          allRouteData.push({ index: idx, route: route, policy: { tag: tag }, mode: 'riding' });
        });
        selectedRouteIndex = 0;
        drawRoutes();
        renderRouteCards();
        addEndpointMarkers(startPos, endPos);
      } else {
        routeCardsEl.innerHTML = '<div class="route-loading">未找到骑行路线</div>';
      }
    });
  }

  // ===== 绘制驾车/步行/骑行路线 =====
  function drawRoutes() {
    routePolylines.forEach(function (l) { l.setMap(null); });
    // 保留起终点标记
    var startEnd = routeLabels.slice(0, 2);
    routeLabels.slice(2).forEach(function (m) { if (m.setMap) m.setMap(null); });
    routeLabels = startEnd;
    routePolylines = [];

    allRouteData.forEach(function (r, idx) {
      var route = r.route;
      var isSelected = (idx === selectedRouteIndex);
      var path = [];

      // 驾车/步行/骑行都是 steps.path 结构
      if (route.steps) {
        route.steps.forEach(function (step) {
          if (step.path) {
            step.path.forEach(function (p) { path.push([p.lng, p.lat]); });
          }
        });
      }

      if (path.length === 0) return;

      var polyline = new AMap.Polyline({
        path: path,
        strokeColor: isSelected ? '#16A34A' : '#AAB7C4',
        strokeWeight: isSelected ? 10 : 5,
        strokeOpacity: isSelected ? 1 : 0.6,
        lineJoin: 'round',
        lineCap: 'round',
        showDir: isSelected,
        // 选中路线用实线，其他路线用虚线，方便司机在地图上比较走向。
        strokeStyle: isSelected ? 'solid' : 'dashed',
        zIndex: isSelected ? 90 : 60,
      });
      map.add(polyline);
      routePolylines.push(polyline);

      // 点击路线切换选中
      polyline.on('click', function () {
        selectedRouteIndex = idx;
        drawRoutes();
        renderRouteCards();
      });
    });

    if (routePolylines.length > 0) {
      map.setFitView(routePolylines, false, [150, 80, Math.min(300, Math.round(window.innerHeight * 0.30)), 80]);
    }
  }

  // ===== 绘制公交路线 =====
  function drawTransitRoutes() {
    routePolylines.forEach(function (l) { l.setMap(null); });
    var startEnd = routeLabels.slice(0, 2);
    routeLabels.slice(2).forEach(function (m) { if (m.setMap) m.setMap(null); });
    routeLabels = startEnd;
    routePolylines = [];

    allRouteData.forEach(function (r, idx) {
      var plan = r.route;  // TransferPlan
      var isSelected = (idx === selectedRouteIndex);

      if (!plan.segments) return;

      plan.segments.forEach(function (seg) {
        var path = [];
        // 公交/地铁段
        if (seg.transit_mode === 'BUS' || seg.transit_mode === 'RAIL' || seg.transit_mode) {
          if (seg.transit.lines && seg.transit.lines.length > 0) {
            var line = seg.transit.lines[0];
            if (line.path) {
              line.path.forEach(function (p) { path.push([p.lng, p.lat]); });
            }
          }
        }
        // 步行段
        if (seg.walking && seg.walking.steps) {
          seg.walking.steps.forEach(function (step) {
            if (step.path) {
              step.path.forEach(function (p) { path.push([p.lng, p.lat]); });
            }
          });
        }

        if (path.length === 0) return;

        var polyline = new AMap.Polyline({
          path: path,
          strokeColor: isSelected ? '#3388FF' : '#B0C4DE',
          strokeWeight: isSelected ? 8 : 4,
          strokeOpacity: isSelected ? 1 : 0.6,
          strokeStyle: 'solid',
          lineJoin: 'round',
          lineCap: 'round',
          zIndex: isSelected ? 90 : 60,
        });
        map.add(polyline);
        routePolylines.push(polyline);
      });

      // 中点标签
      if (routePolylines.length > 0) {
        var lastLine = routePolylines[routePolylines.length - 1];
        var midPath = lastLine.getPath();
        if (midPath && midPath.length > 0) {
          var midIdx = Math.floor(midPath.length / 2);
          var timeStr = formatTime(plan.time);
          var labelBg = isSelected ? '#3388FF' : '#B0C4DE';
          var label = new AMap.Marker({
            position: midPath[midIdx],
            content: '<div style="background:' + labelBg + ';color:white;padding:3px 8px;border-radius:4px;font-size:12px;font-weight:500;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,0.3);">' + timeStr + '</div>',
            offset: new AMap.Pixel(-30, -10),
            zIndex: isSelected ? 150 : 80,
          });
          map.add(label);
          routeLabels.push(label);
        }
      }

      // 点击路线
      routePolylines.forEach(function (pl) {
        pl.on('click', function () {
          selectedRouteIndex = idx;
          drawTransitRoutes();
          renderRouteCards();
        });
      });
    });

    if (routePolylines.length > 0) {
      map.setFitView(routePolylines, false, [80, 80, Math.min(360, Math.round(window.innerHeight * 0.42)), 80]);
    }
  }

  // ===== 起终点标记 =====
  function addEndpointMarkers(startPos, endPos) {
    var startMarker = new AMap.Marker({
      position: startPos,
      icon: new AMap.Icon({ size: new AMap.Size(24, 34), image: '//webapi.amap.com/theme/v1.3/markers/n/start.png', imageSize: new AMap.Size(24, 34) }),
      offset: new AMap.Pixel(-12, -34),
    });
    var endMarker = new AMap.Marker({
      position: endPos,
      icon: new AMap.Icon({ size: new AMap.Size(24, 34), image: '//webapi.amap.com/theme/v1.3/markers/n/end.png', imageSize: new AMap.Size(24, 34) }),
      offset: new AMap.Pixel(-12, -34),
    });
    map.add([startMarker, endMarker]);
    routeLabels = [startMarker, endMarker];
  }

  // ===== 路线卡片渲染 =====
  function renderRouteCards() {
    var html = '';
    allRouteData.forEach(function (r, idx) {
      var isSelected = (idx === selectedRouteIndex);
      html += '<div class="route-card-item' + (isSelected ? ' active' : '') + '" data-index="' + idx + '">' +
        '<div class="route-card-row1">' +
        '<span class="route-card-time">方案' + (idx + 1) + '</span>' +
        '</div>' +
        '<div class="route-card-row2">' +
        '<span class="route-card-tag">' + (isSelected ? '当前路线' : '点击查看') + '</span>' +
        '</div>' +
        '</div>';
    });

    routeCardsEl.innerHTML = html;
    routeLoading.style.display = 'none';

    // 点击卡片切换路线
    routeCardsEl.querySelectorAll('.route-card-item').forEach(function (card) {
      card.addEventListener('click', function () {
        var idx = parseInt(card.getAttribute('data-index'));
        if (allRouteData[idx]) {
          selectedRouteIndex = idx;
          // 重绘路线
          if (currentMode === 'transit') {
            drawTransitRoutes();
          } else {
            drawRoutes();
          }
          renderRouteCards();
        }
      });
    });

  }

  function clearRouteDisplay() {
    routePolylines.forEach(function (l) { l.setMap(null); });
    routeLabels.forEach(function (m) { if (m.setMap) m.setMap(null); });
    routePolylines = [];
    routeLabels = [];
    allRouteData = [];
    routeCardsEl.innerHTML = '';
    routeLoading.style.display = 'none';
  }

  // ===== 事件绑定 =====

  // 首页搜索栏 → 打开搜索页
  homeSearch.addEventListener('click', function () {
    showSearchPage();
  });

  // 搜索页返回
  searchBack.addEventListener('click', function () {
    hideSearchPage();
  });

  // 搜索输入框
  searchInput.addEventListener('focus', function () {
    searchInput.select();
    if (!searchInput.value.trim()) {
      renderHistory();
    }
  });

  searchInput.addEventListener('input', function () {
    var val = searchInput.value.trim();

    // 显示/隐藏清空按钮
    if (val) {
      searchClearInput.classList.remove('hidden');
    } else {
      searchClearInput.classList.add('hidden');
    }

    // 防抖
    if (autocompleteTimer) {
      clearTimeout(autocompleteTimer);
      autocompleteTimer = null;
    }

    if (!val) {
      renderHistory();
      return;
    }

    if (!map) return;

    autocompleteTimer = setTimeout(function () {
      showAutocomplete(val);
    }, 300);
  });

  searchInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      var val = searchInput.value.trim();
      if (val) doSearch(val);
    }
  });

  // 清空输入
  searchClearInput.addEventListener('click', function () {
    searchInput.value = '';
    searchClearInput.classList.add('hidden');
    renderHistory();
    searchInput.focus();
  });

  // 路线页返回
  routeBack.addEventListener('click', function () {
    hideRoutePage();
  });

  // 起终点互换
  swapBtn.addEventListener('click', function () {
    if (!routeEnd) return;
    // 互换终点和当前位置
    var tempEnd = routeEnd;
    if (currentLocation) {
      routeEnd = { pos: currentLocation, name: '我的位置' };
      routeStart = { pos: tempEnd.pos, name: tempEnd.name };
      currentLocation = tempEnd.pos;
    }
    routeStartText.textContent = tempEnd.name;
    routeEndText.textContent = '我的位置';
    // 重新规划
    routeEnd = { pos: routeEnd.pos, name: routeEnd.name };
    doRoutePlan();
  });

  // 出行方式切换
  routeModeLabels.forEach(function (label) {
    label.addEventListener('click', function () {
      routeModeLabels.forEach(function (l) { l.classList.remove('active'); });
      label.classList.add('active');
      currentMode = label.getAttribute('data-mode');
      if (routeEnd) {
        doRoutePlan();
      }
    });
  });

  // 定位按钮
  locateBtn.addEventListener('click', function () {
    doLocate(function (located) {
      if (located) setTrafficHint('当前位置已更新');
      else setTrafficHint('定位失败，请允许浏览器定位');
    });
  });

  // 路况保持开启。这个按钮只负责重新挂载图层，防止误触后看不到拥堵。
  trafficBtn.addEventListener('click', function () {
    if (!trafficLayer) return;
    trafficLayer.setMap(null);
    trafficLayer.setMap(map);
    trafficVisible = true;
    trafficBtn.classList.add('active');
    overviewTileCache.clear();
    scheduleOverviewTraffic();
  });

  settingsBtn.addEventListener('click', function () {
    keyInput.value = key;
    securityInput.value = securityCode;
    keyError.textContent = '';
    keyModal.classList.remove('hidden');
  });

  // 停在城区概览页时也要更新，不能等司机手动缩放地图才换路况。
  setInterval(function () {
    if (document.hidden || !map || map.getZoom() > OVERVIEW_MAX_ZOOM) return;
    overviewTileCache.clear();
    scheduleOverviewTraffic();
  }, TRAFFIC_REFRESH_MS);

  // Key 保存
  saveKey.addEventListener('click', function () {
    var k = keyInput.value.trim();
    if (!k) { keyError.textContent = '请输入Key'; return; }
    key = k;
    securityCode = securityInput.value.trim();
    localStorage.setItem('amap_key', key);
    localStorage.setItem('amap_security', securityCode);
    overviewTileCache.clear();
    keyModal.classList.add('hidden');
    keyError.textContent = '';
    if (map) {
      scheduleOverviewTraffic();
    } else {
      loadMap();
    }
  });

  // ===== 启动 =====
  if (key) {
    loadMap();
  } else {
    keyModal.classList.remove('hidden');
  }

})();
