# NASDAQ Smart Analyzer (Full Data Integration) v2

## New in v2
- NOT_FOUND message: "존재하지 않는 티커입니다."
- 6-section cards (3x2) + animated AI Score strip
- Large final evaluation panel:
  - 재무 상태: 좋음/보통/주의
  - 매수 의견: 추천/고민/비추천
  - 핵심 근거 3줄

## How "AI score" works
This version computes a transparent heuristic score (0-100) from Finnhub metrics:
- Profitability: ROE, operating margin, net margin
- Capital efficiency: ROIC
- Valuation: PE (penalize very high), FCF yield (reward higher)
- Financial health: Debt/Equity, interest coverage, current/quick ratios
- Growth: revenueGrowth3Y, epsGrowth3Y
Then maps to labels.

Because brokers can differ (TTM vs Annual, definitions), you can adjust weights in server.js.

## Setup
1) npm install
2) copy .env.example -> .env and set FINNHUB_API_KEY
3) npm start
Open http://localhost:3000

Generated: 2026-02-28T16:22:43.962349
