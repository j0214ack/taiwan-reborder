# 畫界台灣

**兩個相鄰縣市之間的界線被擦掉了——憑印象把它畫回來。**

每天一題。畫完告訴你劃錯了幾平方公里、把哪塊土地劃給了錯的縣市。

👉 **[開始玩](https://j0214ack.github.io/taiwan-reborder/)**

玩法啟發自 [reborder.app](https://reborder.app)（Draw the missing border between neighbouring countries）的台灣縣市版。

## 玩法

1. 畫面上是兩個相鄰縣市合併成的一塊土地，共同界線被擦掉，只留兩個端點 ●
2. 從一個 ● 一筆畫到另一個 ●
3. 你的線和真實界線圍出的區域＝**你劃錯的領土**，以面積計分

## 細節

- 31 組可玩配對（台灣本島所有相鄰縣市，扣除兩組飛地：台北市╳新北市、嘉義市╳嘉義縣——它們的界線是封閉環，沒辦法「畫一條線」）
- 每日題目以台北時間換日，全站同題；「練習模式」可隨機加練
- 計分方式：你的線＋真實界線圍成的口袋（even-odd）與兩縣市聯集取交集，光柵化數像素 → 錯劃面積比例；再用球面面積換算成 km²
- 純前端單檔 `index.html`，D3 + topojson-client（CDN），無後端、無追蹤
- 圖資：[taiwan-atlas](https://github.com/dkaoster/taiwan-atlas)（內政部縣市界 TopoJSON）

## 本機跑

```sh
python3 -m http.server 8000   # 開 http://localhost:8000
```

開發驗證鉤子：`?test=perfect`（沿真實界線重畫，應得 100%）、`?test=offset`（整條偏移 30px，驗證扣分梯度）。

## License

MIT（圖資依 taiwan-atlas／政府資料開放授權條款）
