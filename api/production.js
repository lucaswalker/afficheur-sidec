export default async function handler(req, res) {
  const BASE_URL = 'https://eu5.fusionsolar.huawei.com';
  const userName = process.env.FS_USER;
  const systemCode = process.env.FS_PASS;
  const stationCode = process.env.STATION_CODE;

  if (!userName || !systemCode || !stationCode) {
    return res.status(500).json({ error: 'Variables d’environnement manquantes sur Vercel.' });
  }

  try {
    // 1. Authentification Northbound API
    const loginRes = await fetch(`${BASE_URL}/thirdData/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userName, systemCode })
    });

    const xsrfToken = loginRes.headers.get('xsrf-token');
    const loginData = await loginRes.json();

    if (!loginData.success || !xsrfToken) {
      return res.status(401).json({
        error: 'Échec de connexion FusionSolar',
        detail: loginData.message || loginData.failCode
      });
    }

    const authHeaders = {
      'Content-Type': 'application/json',
      'XSRF-TOKEN': xsrfToken
    };

    // 2. Lecture des KPI de la centrale (production jour, mois, total)
    const kpiRes = await fetch(`${BASE_URL}/thirdData/getStationRealKpi`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ stationCodes: stationCode })
    });
    const kpiJson = await kpiRes.json();
    const stationMap = kpiJson?.data?.[0]?.dataItemMap || {};

    // 3. Lecture de la puissance instantanée (kW) via l'onduleur (devTypeId = 1)
    let activePowerKw = null;
    const devListRes = await fetch(`${BASE_URL}/thirdData/getDevList`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ stationCodes: stationCode })
    });
    const devListJson = await devListRes.json();
    const inverters = (devListJson?.data || []).filter((d) => d.devTypeId === 1);

    if (inverters.length > 0) {
      const devIds = inverters.map((d) => d.id).join(',');
      const devKpiRes = await fetch(`${BASE_URL}/thirdData/getDevRealKpi`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ devIds, devTypeId: 1 })
      });
      const devKpiJson = await devKpiRes.json();
      activePowerKw = (devKpiJson?.data || []).reduce(
        (sum, item) => sum + (Number(item?.dataItemMap?.active_power) || 0),
        0
      );
    }

    // Cache Vercel de 5 minutes pour respecter la limite Huawei (1 req / 5 min)
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');

    return res.status(200).json({
      activePowerKw: activePowerKw !== null ? Number(activePowerKw.toFixed(2)) : null,
      dayPowerKwh: Number((stationMap.day_power || 0).toFixed(2)),
      monthPowerKwh: Number((stationMap.month_power || 0).toFixed(1)),
      totalPowerKwh: Number((stationMap.total_power || 0).toFixed(1)),
      updatedAt: new Date().toISOString()
    });
  } catch (err) {
    return res.status(500).json({ error: 'Erreur serveur', detail: err.message });
  }
}
