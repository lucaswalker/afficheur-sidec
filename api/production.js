let cachedToken = null;
let tokenExpiresAt = 0;
let cachedDevIds = null;

async function getXsrfToken(baseUrl, userName, systemCode, forceRefresh = false) {
  if (!forceRefresh && cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  const loginRes = await fetch(`${baseUrl}/thirdData/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userName, systemCode })
  });

  const xsrfToken = loginRes.headers.get('xsrf-token');
  const loginData = await loginRes.json();

  if (!loginData.success || !xsrfToken) {
    const err = new Error(loginData.data || loginData.message || 'Échec de connexion FusionSolar');
    err.detail = loginData;
    throw err;
  }

  cachedToken = xsrfToken;
  tokenExpiresAt = Date.now() + 25 * 60 * 1000;
  return cachedToken;
}

export default async function handler(req, res) {
  const BASE_URL = 'https://eu5.fusionsolar.huawei.com';
  const userName = (process.env.FS_USER || '').trim();
  const systemCode = (process.env.FS_PASS || '').trim();
  const stationCode = (process.env.STATION_CODE || '').trim();

  if (!userName || !systemCode || !stationCode) {
    return res.status(500).json({ error: 'Variables d’environnement manquantes sur Vercel.' });
  }

  try {
    let xsrfToken = await getXsrfToken(BASE_URL, userName, systemCode);

    const callHuawei = async (endpoint, payload) => {
      let response = await fetch(`${BASE_URL}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'XSRF-TOKEN': xsrfToken },
        body: JSON.stringify(payload)
      });
      let json = await response.json();

      if (json.failCode === 305) {
        xsrfToken = await getXsrfToken(BASE_URL, userName, systemCode, true);
        response = await fetch(`${BASE_URL}${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'XSRF-TOKEN': xsrfToken },
          body: JSON.stringify(payload)
        });
        json = await response.json();
      }
      return json;
    };

    // 1. KPI de la centrale
    const kpiJson = await callHuawei('/thirdData/getStationRealKpi', {
      stationCodes: stationCode
    });

    if (!kpiJson.success || !Array.isArray(kpiJson.data) || kpiJson.data.length === 0) {
      return res.status(400).json({
        error: `Aucune donnée reçue pour ${stationCode}`,
        detail: kpiJson
      });
    }

    const stationMap = kpiJson.data[0].dataItemMap || {};

    // 2. Récupération (et mise en cache) des IDs onduleurs (devTypeId = 1)
    if (!cachedDevIds) {
      const devListJson = await callHuawei('/thirdData/getDevList', {
        stationCodes: stationCode
      });
      if (devListJson.success && Array.isArray(devListJson.data)) {
        const inverters = devListJson.data.filter((d) => d.devTypeId === 1);
        if (inverters.length > 0) {
          cachedDevIds = inverters.map((d) => d.id).join(',');
        }
      }
    }

    // 3. Puissance instantanée des onduleurs
    let activePowerKw = null;
    if (cachedDevIds) {
      const devKpiJson = await callHuawei('/thirdData/getDevRealKpi', {
        devIds: cachedDevIds,
        devTypeId: 1
      });
      if (devKpiJson.success && Array.isArray(devKpiJson.data)) {
        activePowerKw = devKpiJson.data.reduce(
          (sum, item) => sum + (Number(item?.dataItemMap?.active_power) || 0),
          0
        );
      }
    }

    // Cache Vercel de 5 minutes (protège contre l'erreur 407)
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');

    return res.status(200).json({
      activePowerKw: activePowerKw !== null ? Number(activePowerKw.toFixed(2)) : null,
      dayPowerKwh: Number((stationMap.day_power || 0).toFixed(2)),
      monthPowerKwh: Number((stationMap.month_power || 0).toFixed(1)),
      totalPowerKwh: Number((stationMap.total_power || 0).toFixed(1)),
      updatedAt: new Date().toISOString()
    });
  } catch (err) {
    return res.status(502).json({
      error: err.message || 'Erreur serveur',
      detail: err.detail || null
    });
  }
}
