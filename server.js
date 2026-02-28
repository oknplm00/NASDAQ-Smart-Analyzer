require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const FINNHUB = "https://finnhub.io/api/v1";
const API_KEY = process.env.FINNHUB_API_KEY;
const PORT = Number(process.env.PORT || 3000);

// ---- Cache US symbols (NASDAQ/NYSE/AMEX etc.) ----
let SYMBOL_SET = new Set();
let SYMBOL_LAST_REFRESH = null;

async function refreshSymbolCache() {
  if (!API_KEY) throw new Error("FINNHUB_API_KEY missing");
  const res = await axios.get(`${FINNHUB}/stock/symbol`, {
    params: { exchange: "US", token: API_KEY },
    timeout: 20000
  });
  const list = Array.isArray(res.data) ? res.data : [];
  const set = new Set();
  for (const item of list) {
    if (item && item.symbol) set.add(String(item.symbol).toUpperCase());
  }
  SYMBOL_SET = set;
  SYMBOL_LAST_REFRESH = new Date().toISOString();
}

refreshSymbolCache().catch((e) => {
  console.error("Symbol cache refresh failed:", e.message);
});

function num(v){
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function clamp(x, a, b){ return Math.max(a, Math.min(b, x)); }

function fmtPct(n){
  if (n === null) return "N/A";
  return `${n.toFixed(1)}%`;
}
function fmtNum(n, d=2){
  if (n === null) return "N/A";
  return n.toFixed(d);
}
function fmtCurrencyMillions(n){
  if (n === null) return "N/A";
  return `$${n.toFixed(0)}M`;
}
function safeStr(v, fallback="N/A"){
  if (!v) return fallback;
  return String(v);
}

async function getProfile(symbol) {
  const res = await axios.get(`${FINNHUB}/stock/profile2`, {
    params: { symbol, token: API_KEY },
    timeout: 20000
  });
  return res.data || {};
}
async function getMetricAll(symbol) {
  const res = await axios.get(`${FINNHUB}/stock/metric`, {
    params: { symbol, metric: "all", token: API_KEY },
    timeout: 20000
  });
  return (res.data && res.data.metric) ? res.data.metric : {};
}

// --- Scoring (transparent heuristic, 0-100) ---
function scoreFromMetrics(profile, metric){
  // Pull values (most are in percent units already)
  const roe = num(metric.roeTTM);
  const roic = num(metric.roicTTM);
  const opm = num(metric.operatingMarginTTM);
  const npm = num(metric.netMarginTTM);

  const pe = num(metric.peTTM);
  const fcfTTM = num(metric.freeCashFlowTTM);
  const mcapM = num(profile.marketCapitalization); // millions

  const de = num(metric.totalDebtToEquityAnnual);
  const ic = num(metric.interestCoverageAnnual);
  const cr = num(metric.currentRatioAnnual);
  const qr = num(metric.quickRatioAnnual);

  const revg = num(metric.revenueGrowth3Y);
  const epsg = num(metric.epsGrowth3Y);

  // Compute fcf yield % if possible
  let fcfYield = null;
  if (fcfTTM !== null && mcapM !== null && mcapM > 0){
    const mcap = mcapM * 1_000_000;
    fcfYield = (fcfTTM / mcap) * 100;
  }

  // Subscores 0..100 each (with soft caps)
  const sProfit = clamp(
    ( (roe ?? 0) * 1.2 + (opm ?? 0) * 1.0 + (npm ?? 0) * 0.8 ) / 3.0 * 2.0,
    0, 100
  );

  const sEff = clamp(((roic ?? 0) * 2.0), 0, 100);

  // Valuation: prefer reasonable PE and higher FCF yield
  // PE ideal band 10-25. Penalize >40 strongly; <6 mildly (could be risk)
  let sPE = 50;
  if (pe === null) sPE = 45;
  else if (pe < 6) sPE = 40;
  else if (pe <= 25) sPE = 80 - (pe - 10) * 2.0; // 10->80, 25->50
  else if (pe <= 40) sPE = 50 - (pe - 25) * 1.5; // 25->50, 40->27.5
  else sPE = 25 - (pe - 40) * 0.8; // 40->25, 60->9

  sPE = clamp(sPE, 0, 100);

  let sFCF = 45;
  if (fcfYield === null) sFCF = 45;
  else if (fcfYield <= 0) sFCF = 20;
  else if (fcfYield < 2) sFCF = 45 + fcfYield * 10; // up to 65
  else if (fcfYield < 6) sFCF = 65 + (fcfYield - 2) * 7; // up to 93
  else sFCF = 95; // very attractive

  const sVal = clamp((sPE * 0.65 + sFCF * 0.35), 0, 100);

  // Health: lower D/E better; higher interest coverage better; liquidity reasonable
  let sDE = 55;
  if (de === null) sDE = 50;
  else if (de <= 50) sDE = 90 - de * 0.6; // 0->90, 50->60
  else if (de <= 150) sDE = 60 - (de - 50) * 0.25; // 50->60, 150->35
  else sDE = 30 - (de - 150) * 0.05; // 150->30, 350->20
  sDE = clamp(sDE, 0, 100);

  let sIC = 55;
  if (ic === null) sIC = 50;
  else if (ic < 1.5) sIC = 10;
  else if (ic < 5) sIC = 30 + (ic - 1.5) * 8;
  else if (ic < 15) sIC = 58 + (ic - 5) * 3.5;
  else sIC = 93;
  sIC = clamp(sIC, 0, 100);

  let sLiq = 50;
  const crN = cr ?? null, qrN = qr ?? null;
  if (crN !== null && qrN !== null){
    // Ideal: current 1.2~2.5, quick 1.0~2.0
    const crScore = clamp(80 - Math.abs(crN - 1.8) * 25, 20, 90);
    const qrScore = clamp(80 - Math.abs(qrN - 1.4) * 30, 20, 90);
    sLiq = (crScore + qrScore) / 2;
  }
  const sHealth = clamp((sDE*0.45 + sIC*0.35 + sLiq*0.20), 0, 100);

  // Growth: reward positive growth; cap extremes
  let sGrowth = 50;
  const g1 = revg ?? 0;
  const g2 = epsg ?? 0;
  sGrowth = clamp(50 + g1*1.2 + g2*1.0, 0, 100);

  // Final weighted score
  const score = clamp(
    sProfit*0.22 + sEff*0.14 + sVal*0.18 + sHealth*0.24 + sGrowth*0.22,
    0, 100
  );

  // Labels
  const financialState =
    score >= 75 ? "좋음" : (score >= 55 ? "보통" : "주의");
  const buyOpinion =
    score >= 80 ? "추천" : (score >= 60 ? "고민" : "비추천");

  // Key reasons (top 3 subscores)
  const subs = [
    ["수익성", sProfit],
    ["자본 효율", sEff],
    ["밸류에이션", sVal],
    ["재무 건전성", sHealth],
    ["성장성", sGrowth],
  ].sort((a,b)=>b[1]-a[1]);

  const reasons = subs.slice(0,3).map(([k,v]) => `${k} 점수 ${v.toFixed(0)}/100`);

  // Also capture potential red flags
  const flags = [];
  if (ic !== null && ic < 2) flags.push("이자보상배율이 낮음");
  if (de !== null && de > 150) flags.push("부채비율이 높은 편");
  if (pe !== null && pe > 60) flags.push("PER이 매우 높음");
  if (fcfYield !== null && fcfYield < 1) flags.push("FCF 수익률이 낮음");
  if (revg !== null && revg < 0) flags.push("매출 성장률이 음수");

  return {
    score: Number(score.toFixed(1)),
    financialState,
    buyOpinion,
    reasons,
    flags
  };
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    symbolCacheSize: SYMBOL_SET.size,
    symbolCacheLastRefresh: SYMBOL_LAST_REFRESH
  });
});

app.get("/api/analyze", async (req, res) => {
  try {
    if (!API_KEY) return res.status(500).json({ error: "SERVER_MISSING_API_KEY" });

    const ticker = String(req.query.ticker || "").trim().toUpperCase();
    if (!ticker) return res.status(400).json({ error: "TICKER_REQUIRED" });

    let exists = SYMBOL_SET.size ? SYMBOL_SET.has(ticker) : null;

    const profile = await getProfile(ticker);
    const hasProfile = !!(profile && profile.ticker);

    if (exists === null) exists = hasProfile;
    if (!exists || !hasProfile) return res.json({ error: "NOT_FOUND" });

    const metric = await getMetricAll(ticker);

    // FCF Yield computation for display
    const fcfTTM = num(metric.freeCashFlowTTM);
    const mcapM = num(profile.marketCapitalization); // millions
    let fcfYield = "N/A";
    if (fcfTTM !== null && mcapM !== null && mcapM > 0) {
      const mcap = mcapM * 1_000_000;
      fcfYield = `${((fcfTTM / mcap) * 100).toFixed(2)}%`;
    }

    const mapped = {
      "1": {
        title: "수익성",
        items: [
          { label: "ROE (TTM)", value: fmtPct(num(metric.roeTTM)), key: "roeTTM" },
          { label: "영업이익률 (TTM)", value: fmtPct(num(metric.operatingMarginTTM)), key: "operatingMarginTTM" },
          { label: "순이익률 (TTM)", value: fmtPct(num(metric.netMarginTTM)), key: "netMarginTTM" }
        ]
      },
      "2": {
        title: "자본 효율",
        items: [
          { label: "ROIC (TTM)", value: fmtPct(num(metric.roicTTM)), key: "roicTTM" },
          { label: "총자산회전율 (Annual)", value: fmtNum(num(metric.assetTurnoverAnnual), 2), key: "assetTurnoverAnnual" }
        ]
      },
      "3": {
        title: "밸류에이션",
        items: [
          { label: "PER (TTM)", value: fmtNum(num(metric.peTTM), 2), key: "peTTM" },
          { label: "PBR (Annual)", value: fmtNum(num(metric.pbAnnual), 2), key: "pbAnnual" },
          { label: "FCF Yield (computed)", value: fcfYield, key: "freeCashFlowTTM + marketCapitalization" }
        ]
      },
      "4": {
        title: "재무 건전성",
        items: [
          { label: "부채비율 D/E (Annual)", value: fmtNum(num(metric.totalDebtToEquityAnnual), 2), key: "totalDebtToEquityAnnual" },
          { label: "이자보상배율 (Annual)", value: fmtNum(num(metric.interestCoverageAnnual), 2), key: "interestCoverageAnnual" },
          { label: "유동비율 (Annual)", value: fmtNum(num(metric.currentRatioAnnual), 2), key: "currentRatioAnnual" },
          { label: "당좌비율 (Annual)", value: fmtNum(num(metric.quickRatioAnnual), 2), key: "quickRatioAnnual" }
        ]
      },
      "5": {
        title: "주주환원",
        items: [
          { label: "배당성향 (Annual)", value: fmtPct(num(metric.payoutRatioAnnual)), key: "payoutRatioAnnual" },
          { label: "배당 성장률 5Y (Annual)", value: fmtPct(num(metric.dividendGrowthRate5Y)), key: "dividendGrowthRate5Y" },
          { label: "자사주 (sharesYoY)", value: fmtPct(num(metric.sharesYoY)), key: "sharesYoY" }
        ]
      },
      "6": {
        title: "성장 & 질적 경쟁력",
        items: [
          { label: "매출 성장률 3Y (Annual)", value: fmtPct(num(metric.revenueGrowth3Y)), key: "revenueGrowth3Y" },
          { label: "EPS 성장률 3Y (Annual)", value: fmtPct(num(metric.epsGrowth3Y)), key: "epsGrowth3Y" },
          { label: "산업 분류", value: safeStr(profile.finnhubIndustry), key: "profile2.finnhubIndustry" }
        ]
      }
    };

    const company = {
      ticker: profile.ticker,
      name: profile.name,
      exchange: profile.exchange || "US",
      industry: profile.finnhubIndustry || "N/A",
      category: profile.finnhubIndustry || "N/A",
      website: profile.weburl || "",
      marketCap: fmtCurrencyMillions(num(profile.marketCapitalization)),
      blurb: `${safeStr(profile.name)}는(은) ${safeStr(profile.finnhubIndustry)} 분야에 속한 미국 상장 기업입니다.`
    };

    const ai = scoreFromMetrics(profile, metric);

    res.json({
      company,
      sections: mapped,
      ai,
      audit: {
        source: "Finnhub",
        symbolCacheLastRefresh: SYMBOL_LAST_REFRESH
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "SERVER_ERROR", message: e.message });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
