"use strict";
const $=s=>document.querySelector(s);
const R_EARTH=6371;                        // km
let topo,counties,geoms,pool,cur=null;
let drawing=false,pts=[],done=false,activePtr=null;
/* localStorage 被瀏覽器封鎖（封鎖全部 cookies）會 throw——包起來別讓整頁死掉 */
const store={
  get:k=>{try{return localStorage.getItem(k)}catch{return null}},
  set:(k,v)=>{try{localStorage.setItem(k,v)}catch{}},
};
/* 模式：free＝原版自由畫（預設）；easy＝顯示端點提示 */
let mode=store.get("huajie.mode")==="easy"?"easy":"free";
const REDUCED=matchMedia("(prefers-reduced-motion: reduce)").matches;
let revealT0=-1e9;                         // 揭曉劃線動畫起點（-1e9＝視為已播完）

/* ── 幾何 ── */
const cname=g=>g.properties.COUNTYNAME;
function borderOf(a,b){
  return topojson.mesh(topo,{type:"GeometryCollection",geometries:[a,b]},(x,y)=>x!==y);
}
function isRing(line){const s=line[0],e=line[line.length-1];return s[0]===e[0]&&s[1]===e[1]}
function buildPool(){
  const out=[];
  for(let i=0;i<geoms.length;i++)for(let j=i+1;j<geoms.length;j++){
    const m=borderOf(geoms[i],geoms[j]);
    if(!m.coordinates.length) continue;
    if(m.coordinates.some(isRing)) continue;          // 飛地（台北市/新北市、嘉義市/嘉義縣）不可畫線
    out.push([i,j]);
  }
  return out;
}

/* ── 畫布 ── */
const cv=$("#map"),ctx=cv.getContext("2d");
let W=0,H=0,DPR=1,proj,path,anchors=[],SNAP=26;
function resize(){
  const r=cv.getBoundingClientRect();
  DPR=Math.min(window.devicePixelRatio||1,2);
  W=Math.round(r.width);H=Math.round(r.height);
  cv.width=W*DPR;cv.height=H*DPR;
  ctx.setTransform(DPR,0,0,DPR,0,0);
  if(cur) fit(), render();
}
function fit(){
  const k0=proj?proj.scale():0,t0=proj?proj.translate():null;
  proj=d3.geoMercator();
  const pad=34;
  proj.fitExtent([[pad,pad+6],[W-pad,H-pad-6]],cur.unionFeat);
  // 使用者已畫的線是像素座標，投影變了（揭曉時面板改變 stage 高度、轉向、拉視窗）要跟著重映射，
  // 否則線會離界飄移；Mercator fitExtent 只差等比縮放＋平移，仿射轉換精確
  if(t0&&pts.length){const f=proj.scale()/k0,t=proj.translate();pts=pts.map(p=>[(p[0]-t0[0])*f+t[0],(p[1]-t0[1])*f+t[1]])}
  path=d3.geoPath(proj,ctx);
  cur.borderPx=cur.borderGeo.map(p=>proj(p));
  anchors=[cur.borderPx[0],cur.borderPx[cur.borderPx.length-1]];
  cur.borderCum=[0];
  for(let i=1;i<cur.borderPx.length;i++)cur.borderCum.push(cur.borderCum[i-1]+dist(cur.borderPx[i-1],cur.borderPx[i]));
  // 計分脈絡（隨視窗尺寸重算）：kmPerPx＝沿界線實長換算；extentKm＝這張圖（聯集外框）的對角線
  cur.kmPerPx=cur.Lkm/Math.max(1e-6,polyLen(cur.borderPx));
  const bb=d3.geoPath(proj).bounds(cur.unionFeat);
  cur.extentKm=Math.hypot(bb[1][0]-bb[0][0],bb[1][1]-bb[0][1])*cur.kmPerPx;
  // 計分尺度＝界線本身的大小（界線外框對角線，km）——不是整張圖：短界線題才不會「畫什麼都差不多」
  const xs=cur.borderPx.map(p=>p[0]),ys=cur.borderPx.map(p=>p[1]);
  cur.borderKm=Math.max(1e-6,Math.hypot(Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys))*cur.kmPerPx);
}
function haversineKm(p,q){
  const rad=Math.PI/180;
  const dLat=(q[1]-p[1])*rad, dLon=(q[0]-p[0])*rad;
  const s=Math.sin(dLat/2)**2+Math.cos(p[1]*rad)*Math.cos(q[1]*rad)*Math.sin(dLon/2)**2;
  return 2*R_EARTH*Math.asin(Math.sqrt(s));
}
function loadRound(pair){
  const [i,j]=pair;
  const a=geoms[i],b=geoms[j];
  const union=topojson.merge(topo,[a,b]);
  const mesh=borderOf(a,b);
  // 取最長線段（資料驗證全為單段，此為保險）
  const line=mesh.coordinates.slice().sort((p,q)=>q.length-p.length)[0];
  let Lkm=0;
  for(let k=1;k<line.length;k++)Lkm+=haversineKm(line[k-1],line[k]);
  cur={a,b,
    unionGeom:union,
    unionFeat:{type:"Feature",geometry:union},
    featA:{type:"Feature",geometry:topojson.merge(topo,[a])},
    featB:{type:"Feature",geometry:topojson.merge(topo,[b])},
    borderGeo:line,
    Lkm,
    unionKm2:d3.geoArea(union)*R_EARTH*R_EARTH,
  };
  pts=[];done=false;$("#result").classList.remove("show");
  // textContent 拼裝（不走 innerHTML——縣市名今日來自受信圖資，防未來資料源改變）
  const tk=$("#task");tk.textContent="";
  const bA=document.createElement("b");bA.textContent=cname(a);
  const vs=document.createElement("span");vs.className="vs";vs.textContent="×";
  const bB=document.createElement("b");bB.textContent=cname(b);
  tk.append(bA,vs,bB," 之間的界線被擦掉了——憑印象把它畫回來。");
  fit();render();updateHint();
}

/* ── 渲染 ── */
function drawGeo(feat){ctx.beginPath();path(feat.geometry||feat);}
function render(){
  ctx.clearRect(0,0,W,H);
  // 陸地
  drawGeo(cur.unionFeat);
  ctx.fillStyle=getCss("--land");ctx.fill();
  ctx.strokeStyle=getCss("--landline");ctx.lineWidth=1.6;ctx.lineJoin="round";ctx.stroke();

  if(done){
    // 揭曉動畫：真實界線先劃線（0.9s easeOut），偏差區塊再淡入（0.75→1.15s）
    const el=performance.now()-revealT0;
    const lp=1-Math.pow(1-Math.min(1,el/900),3);
    const pa=Math.min(1,Math.max(0,(el-750)/400));
    if(pa>0){
      // 偏差區塊（口袋 ∩ 聯集）。自由畫的線頭尾不連錨點，先接到界線端點再閉合
      ctx.save();ctx.globalAlpha=pa;
      drawGeo(cur.unionFeat);ctx.clip();
      ctx.beginPath();
      pts.forEach((p,k)=>k?ctx.lineTo(p[0],p[1]):ctx.moveTo(p[0],p[1]));
      for(let k=cur.borderPx.length-1;k>=0;k--)ctx.lineTo(cur.borderPx[k][0],cur.borderPx[k][1]);
      ctx.closePath();
      ctx.fillStyle=getCss("--wrong");ctx.fill("evenodd");
      ctx.restore();
    }
    // 真實界線（依弧長劃到 lp）
    const cum=cur.borderCum,target=lp*cum[cum.length-1];
    ctx.beginPath();ctx.moveTo(cur.borderPx[0][0],cur.borderPx[0][1]);
    for(let i=1;i<cur.borderPx.length;i++){
      if(cum[i]<=target)ctx.lineTo(cur.borderPx[i][0],cur.borderPx[i][1]);
      else{
        const seg=cum[i]-cum[i-1],f=seg?(target-cum[i-1])/seg:0;
        ctx.lineTo(cur.borderPx[i-1][0]+(cur.borderPx[i][0]-cur.borderPx[i-1][0])*f,
                   cur.borderPx[i-1][1]+(cur.borderPx[i][1]-cur.borderPx[i-1][1])*f);
        break;
      }
    }
    ctx.strokeStyle=getCss("--truth");ctx.lineWidth=2.6;ctx.setLineDash([7,5]);ctx.stroke();ctx.setLineDash([]);
  }
  // 使用者的線
  if(pts.length>1){
    ctx.beginPath();
    pts.forEach((p,k)=>k?ctx.lineTo(p[0],p[1]):ctx.moveTo(p[0],p[1]));
    ctx.strokeStyle=getCss("--me");ctx.lineWidth=3;ctx.lineCap="round";ctx.lineJoin="round";ctx.stroke();
  }
  // 端點錨點：只有提示模式顯示（自由畫模式下「起訖在哪」本身是考題）；揭曉後兩種模式都顯示
  if(mode==="easy"||done){
    for(const a of anchors){
      ctx.beginPath();ctx.arc(a[0],a[1],7,0,7);ctx.fillStyle="#FDFCF8";ctx.fill();
      ctx.lineWidth=2.4;ctx.strokeStyle=getCss(done&&mode==="free"?"--truth":"--me");ctx.stroke();
      ctx.beginPath();ctx.arc(a[0],a[1],2.6,0,7);ctx.fillStyle=getCss(done&&mode==="free"?"--truth":"--me");ctx.fill();
    }
  }
  // 縣市名（揭曉前放質心，揭曉後不變）；地圖被壓太矮（橫式揭曉）名字放不下就省略——題目列本來就有兩縣名
  if(H<190)return;
  ctx.font=`600 ${Math.max(H<260?12:15,Math.min(19,W/22))}px ${getCss("--sans")}`;
  ctx.textAlign="center";ctx.textBaseline="middle";
  for(const [f,g] of [[cur.featA,cur.a],[cur.featB,cur.b]]){
    const c=d3.geoPath(proj).centroid(f);
    if(!isFinite(c[0]))continue;
    const t=cname(g);
    ctx.lineWidth=4;ctx.strokeStyle="rgba(246,244,236,.85)";ctx.strokeText(t,c[0],c[1]);
    ctx.fillStyle=done?getCss("--ink"):getCss("--ink2");ctx.fillText(t,c[0],c[1]);
  }
}
function getCss(v){return getComputedStyle(document.documentElement).getPropertyValue(v).trim()}

/* ── 幾何工具（計分共用）── */
const dist=(p,q)=>Math.hypot(p[0]-q[0],p[1]-q[1]);
function segDist(p,a,b){
  const vx=b[0]-a[0],vy=b[1]-a[1];
  const t=Math.max(0,Math.min(1,((p[0]-a[0])*vx+(p[1]-a[1])*vy)/(vx*vx+vy*vy||1)));
  return Math.hypot(p[0]-a[0]-t*vx,p[1]-a[1]-t*vy);
}
function polyLen(pts){let s=0;for(let i=1;i<pts.length;i++)s+=dist(pts[i-1],pts[i]);return s}
function nearestD(p,poly){let m=1/0;for(let i=1;i<poly.length;i++)m=Math.min(m,segDist(p,poly[i-1],poly[i]));return m}
function resampleN(pts,n){
  if(pts.length<2)return pts.slice();
  const c=[0];for(let i=1;i<pts.length;i++)c.push(c[i-1]+dist(pts[i-1],pts[i]));
  const L=c[c.length-1],out=[];let j=1;
  for(let k=0;k<n;k++){
    const t=k/(n-1)*L;
    while(j<c.length-1&&c[j]<t)j++;
    const seg=c[j]-c[j-1],f=seg?(t-c[j-1])/seg:0;
    out.push([pts[j-1][0]+(pts[j][0]-pts[j-1][0])*f,pts[j-1][1]+(pts[j][1]-pts[j-1][1])*f]);
  }
  return out;
}
const meanOf=a=>a.reduce((x,y)=>x+y,0)/a.length;

/* ── 輸入 ── */
function xy(e){const r=cv.getBoundingClientRect();return[e.clientX-r.left,e.clientY-r.top]}
document.addEventListener("gesturestart",e=>e.preventDefault(),{passive:false});
cv.addEventListener("contextmenu",e=>e.preventDefault());
cv.addEventListener("dblclick",e=>e.preventDefault());
cv.addEventListener("pointerdown",e=>{
  if(done)return;
  if(drawing)return;                                  // 第二指誤觸不重設線
  const p=xy(e);
  if(pts.length>1&&dist(p,pts[pts.length-1])<SNAP){
    // 從線尾繼續畫（easy 沒畫到另一端、或 pointercancel 中斷後）
  }else if(mode==="easy"){
    const near=anchors.find(a=>dist(p,a)<SNAP);
    if(!near){toast("從其中一個 ● 開始畫");return}
    pts=[near.slice()];
  }else{
    pts=[p];
  }
  drawing=true;activePtr=e.pointerId;
  cv.setPointerCapture(e.pointerId);
  render();
});
cv.addEventListener("pointermove",e=>{
  if(!drawing||e.pointerId!==activePtr)return;
  const p=xy(e);
  if(dist(p,pts[pts.length-1])>2.2){pts.push(p);render()}
});
cv.addEventListener("pointerup",e=>{
  if(!drawing||e.pointerId!==activePtr)return;
  drawing=false;activePtr=null;
  if(mode==="easy"){
    const start=pts[0],end=pts[pts.length-1];
    const other=anchors.find(a=>dist(a,start)>1);     // 另一端
    if(dist(end,other)<SNAP*1.4){pts.push(other.slice());finish()}
    else toast("還沒畫到另一個 ●——可以從線尾接著畫");   // 已畫的段保留，別讓一次誤放全部蒸發
  }else{
    // 自由畫：太短視為誤觸
    if(polyLen(pts)<dist(anchors[0],anchors[1])*0.4){toast("線太短了——要畫出整條界線（包含它從哪開始、到哪結束）");pts=[];render()}
    else finish();
  }
});
cv.addEventListener("pointercancel",e=>{
  // 來電／通知中心手勢打斷：視同放手但保留已畫的線，可從線尾續畫
  if(e.pointerId!==activePtr)return;
  drawing=false;activePtr=null;render();
});

/* ── 計分（v2）：弧長對應（Yo 的同位置比同位置）＋對稱最近距離＋P90，
      寬容區內不扣分，難度尺度＝本題直線亂猜的平均偏移 ── */
function trimToBorder(U){
  // 把使用者線裁到「最接近界線兩端」的區間——超畫的尾巴不進距離計分
  //（否則尾巴同時污染對應／Chamfer／P90 三項；端點準度另計，超畫仍會小扣）
  const b0=cur.borderPx[0],b1=cur.borderPx[cur.borderPx.length-1];
  let i0=0,i1=U.length-1,d0=1/0,d1=1/0;
  U.forEach((p,i)=>{const a=dist(p,b0),b=dist(p,b1);if(a<d0){d0=a;i0=i}if(b<d1){d1=b;i1=i}});
  const lo=Math.min(i0,i1),hi=Math.max(i0,i1);
  return hi-lo>=8?U.slice(lo,hi+1):U;
}
/* 計分 v4（Yo 2026-09-09 定案）：「你的線偏離真實界線多遠」÷「這條界線本身的大小」＝相對偏移。
   - 尺度＝界線外框對角線（不是整張圖）：Yo 的直覺是「偏了界線本身的百分之幾」；用整張圖當尺度時，
     短界線題（新竹宜蘭）整條起伏只有一指寬，直線亂猜也拿 90。
   - 「一指寬」寬容區：每個取樣點的偏差先扣掉 TOL_REL、不足歸零再雙向平均——整條均勻差一點幾乎免費，局部大歪照罰。
   - 分數＝100·2^(−相對偏移/HALF_REL)。兩個參數，皆可用 ?tol=&half=（百分比）暫時覆寫供校準。
   平均偏離＝對稱最近距離；超畫過端點的尾巴先裁掉不計（起訖偏移只顯示不扣分）。 */
const _q0=new URLSearchParams(location.search);
const HALF_REL=(+_q0.get("half")||6)/100;
const TOL_REL=(+_q0.get("tol")||1.5)/100;
function computeScore(){
  const K=cur.kmPerPx,E=cur.borderKm;
  const B=resampleN(cur.borderPx,128);
  const Ut=trimToBorder(resampleN(pts,128));
  const U=resampleN(Ut,128);
  const dBU=B.map(p=>nearestD(p,Ut));
  const dUB=U.map(p=>nearestD(p,cur.borderPx));
  const chamKm=(meanOf(dBU)+meanOf(dUB))/2*K;   // 誠實量測：未扣寬容的平均偏離
  const rel=chamKm/E;
  const excess=d=>Math.max(0,d*K/E-TOL_REL);
  const relEff=(meanOf(dBU.map(excess))+meanOf(dUB.map(excess)))/2;
  const b0=cur.borderPx[0],b1=cur.borderPx[cur.borderPx.length-1];
  const u0=pts[0],u1=pts[pts.length-1];
  const endKm=Math.min((dist(b0,u0)+dist(b1,u1))/2,(dist(b0,u1)+dist(b1,u0))/2)*K;
  return{
    pct:Math.max(0,Math.min(100,Math.round(100*Math.pow(2,-relEff/HALF_REL)))),
    pctRaw:Math.max(0,Math.min(100,Math.round(100*Math.pow(2,-rel/HALF_REL)))),   // v3（無寬容）對照用
    meanDevKm:chamKm,
    relPct:rel*100,
    areaKm2:chamKm*cur.Lkm,      // ≈ ∫偏移 ds，當分享哏不當分數
    endKm,
    dbg:{chamKm,rel:rel*100,relEff:relEff*100,borderKm:cur.borderKm,extentKm:cur.extentKm,kmPerPx:cur.kmPerPx},
  };
}
function finish(){
  done=true;
  const r=computeScore();
  const pct=r.pct;
  const grade=pct>=95?"🏆 神級":pct>=85?"🥇 在地人":pct>=70?"🥈 有印象":pct>=50?"🥉 大概方向對":"🧭 迷路了";
  $("#grade").textContent=grade;
  const dev=r.meanDevKm<10?r.meanDevKm.toFixed(1):Math.round(r.meanDevKm);
  const km2=r.areaKm2<10?r.areaKm2.toFixed(1):Math.round(r.areaKm2);
  // 主行只留一個主角（平均偏 km）；換算細節降為小字第二行
  let extra=mode==="free"&&r.endKm>0.05*cur.borderKm?`；起訖點偏了約 ${r.endKm.toFixed(1)} km`:"";
  $("#detail").innerHTML=`你的線平均偏離真實界線 <b>${dev} km</b>${extra}`+
    `<span class="fine">＝這條界線大小的 ${r.relPct.toFixed(1)}%・一指寬（${(TOL_REL*100).toFixed(1)}%）內不扣、超出部分每 ${(HALF_REL*100).toFixed(1)}% 砍半・≈ 劃錯 ${km2} km² 的領土</span>`;
  $("#result").classList.add("show");
  cur.lastPct=pct;cur.lastPctRaw=r.pctRaw;cur.lastGrade=grade;cur.lastDev=r.meanDevKm;cur.lastKm2=r.areaKm2;
  revealT0=REDUCED?-1e9:performance.now();            // 減少動態：直接顯示終態
  $("#score").textContent=(REDUCED?pct:0)+"%";
  requestAnimationFrame(stepReveal);
  render();
}
function stepReveal(){
  if(!done)return;
  const el=performance.now()-revealT0;
  // 分數跟著劃線動畫爬升，別在動畫還沒演完時先暴雷
  $("#score").textContent=Math.round(cur.lastPct*Math.min(1,Math.max(0,el/1100)))+"%";
  render();
  if(el<1300)requestAnimationFrame(stepReveal);
  else $("#score").textContent=cur.lastPct+"%";
}

/* ── 工具 ── */
let toastT;
function toast(t,ms){const el=$("#toast");el.textContent=t;el.classList.add("show");clearTimeout(toastT);toastT=setTimeout(()=>el.classList.remove("show"),ms||1900)}
function updateHint(){
  $("#hint").textContent=mode==="easy"
    ?"從一個 ● 一筆畫到另一個 ●"
    :"憑印象一筆畫出整條界線——從哪開始、到哪結束，也是題目的一部分";
  $("#btnMode").textContent=mode==="easy"?"提示：開":"提示：關";
  $("#btnMode").setAttribute("aria-pressed",mode==="easy");
}
$("#btnMode").onclick=()=>{
  mode=mode==="easy"?"free":"easy";
  store.set("huajie.mode",mode);
  pts=[];done=false;$("#result").classList.remove("show");
  updateHint();render();
  toast(mode==="easy"?"提示開啟：顯示界線兩端 ●，畫線頭尾吸附":"提示關閉：整條界線（含起訖）都憑印象");
};
$("#btnClear").onclick=()=>{if(done)return;pts=[];render()};
$("#btnAgain").onclick=()=>{pts=[];done=false;$("#result").classList.remove("show");render()};
$("#btnNext").onclick=()=>loadRound(pool[Math.floor(Math.random()*pool.length)]);
$("#btnPractice").onclick=()=>$("#btnNext").onclick();
function shareText(){
  const blocks=(p=>p>=95?"🟩🟩🟩🟩🟩":p>=85?"🟩🟩🟩🟩⬜":p>=70?"🟩🟩🟩⬜⬜":p>=50?"🟩🟩⬜⬜⬜":"🟩⬜⬜⬜⬜")(cur.lastPct);
  const devTxt=cur.lastDev<10?cur.lastDev.toFixed(1):Math.round(cur.lastDev);
  const modeTag=mode==="easy"?"（提示模式）":"";
  // 連結帶題目：接收的人點開直接玩同一題（同題才比得起來）
  const url=`${location.origin+location.pathname}?pair=${encodeURIComponent(cname(cur.a))},${encodeURIComponent(cname(cur.b))}`;
  return`畫界台灣${modeTag}\n${cname(cur.a)} × ${cname(cur.b)}\n${blocks} ${cur.lastPct}%（平均偏 ${devTxt} km）\n換你畫這題：${url}`;
}
/* ── 成績卡：揭曉畫面合成一張可分享 PNG（1080×1350，純客戶端）── */
function buildShareCard(){
  if(done){revealT0=-1e9;render()}          // 動畫未播完就分享→先跳到完成狀態再快照
  const CW=1080,CH=1350,M=64;
  const c=document.createElement("canvas");c.width=CW;c.height=CH;
  const g=c.getContext("2d");
  const sans=getCss("--sans");
  g.fillStyle=getCss("--paper");g.fillRect(0,0,CW,CH);
  // 標題列：畫界台灣 #N ─────── 縣市對
  g.textBaseline="alphabetic";
  g.textAlign="left";g.fillStyle=getCss("--ink");g.font=`800 54px ${sans}`;
  g.fillText("畫界台灣",M,118);
  const tw=g.measureText("畫界台灣").width;
  g.fillStyle=getCss("--ink3");g.font=`600 40px ${sans}`;
  if(mode==="easy")g.fillText("提示模式",M+tw+22,118);
  g.textAlign="right";g.fillStyle=getCss("--ink");g.font=`700 44px ${sans}`;
  g.fillText(`${cname(cur.a)} × ${cname(cur.b)}`,CW-M,118);
  // 分數列
  g.textAlign="left";g.fillStyle=getCss("--me");g.font=`800 148px ${sans}`;
  g.fillText(cur.lastPct+"%",M,290);
  const sw=g.measureText(cur.lastPct+"%").width;
  g.fillStyle=getCss("--ink");g.font=`700 54px ${sans}`;
  g.fillText(cur.lastGrade,M+sw+30,290);
  // 地圖快照：直接取畫面 canvas（已是揭曉狀態），等比置中
  const box={x:M,y:330,w:CW-2*M,h:830};
  const s=Math.min(box.w/cv.width,box.h/cv.height);
  const dw=cv.width*s,dh=cv.height*s;
  g.drawImage(cv,box.x+(box.w-dw)/2,box.y+(box.h-dh)/2,dw,dh);
  // 底部：偏差＋網址＋出處
  const devTxt=cur.lastDev<10?cur.lastDev.toFixed(1):Math.round(cur.lastDev);
  const km2=cur.lastKm2<10?cur.lastKm2.toFixed(1):Math.round(cur.lastKm2);
  g.fillStyle=getCss("--ink2");g.font=`500 38px ${sans}`;
  g.fillText(`平均偏離真實界線 ${devTxt} km（≈ 劃錯 ${km2} km²）`,M,1226);
  g.fillStyle=getCss("--ink3");g.font=`500 36px ${getCss("--mono")}`;
  g.fillText(location.origin+location.pathname,M,1282);
  g.fillStyle=getCss("--ink3");g.font=`400 26px ${sans}`;
  g.fillText("本 App 靈感來源自 reborder.app・作者 yo-chen.dev",M,1326);
  return c;
}
const cardBlob=()=>new Promise(r=>buildShareCard().toBlob(r,"image/png"));
// 產圖有幾百 ms 延遲：按下後鈕面顯示 loading（Yo 2026-08-31）
async function withBusy(btn,fn){
  const orig=btn.textContent;
  btn.disabled=true;btn.textContent="⏳ 產圖中…";
  try{await fn()}finally{btn.disabled=false;btn.textContent=orig}
}
$("#btnShare").onclick=()=>withBusy($("#btnShare"),async()=>{
  const txt=shareText();
  // 能「圖＋文」一起就一起；只能擇一→文字優先（Yo 裁定）
  let file=null;
  try{file=new File([await cardBlob()],"huajie-taiwan.png",{type:"image/png"})}catch{}
  if(file&&navigator.share&&navigator.canShare&&navigator.canShare({files:[file],text:txt})){
    try{await navigator.share({text:txt,files:[file]});return}
    catch(e){if(e.name==="AbortError")return}   // 使用者取消就停，其他錯往下退
  }
  try{
    if(navigator.share)await navigator.share({text:txt});
    else{await navigator.clipboard.writeText(txt);toast("已複製，貼去炫耀吧")}
  }catch(e){if(e&&e.name!=="AbortError")toast("分享失敗，請再試一次")}
});
// 手機（粗指標）share sheet 本來就有「儲存影像」，且 ClipboardItem/download 在手機不可靠→整顆藏掉（Yo 2026-08-31）
if(matchMedia("(pointer:coarse)").matches)$("#btnSaveImg").style.display="none";
$("#btnSaveImg").onclick=()=>withBusy($("#btnSaveImg"),async()=>{
  try{
    const blob=await cardBlob();
    if(navigator.clipboard&&window.ClipboardItem){
      await navigator.clipboard.write([new ClipboardItem({"image/png":blob})]);
      toast("成績圖已複製，直接貼上");return;
    }
    throw 0;
  }catch{
    try{
      const a=document.createElement("a");
      a.href=buildShareCard().toDataURL("image/png");
      a.download=`畫界台灣-${cname(cur.a)}x${cname(cur.b)}.png`;
      a.click();toast("成績圖已下載");
    }catch{toast("這個瀏覽器存不了圖")}
  }
});

/* ── 啟動 ── */
fetch("counties-10t.json").then(r=>r.json()).then(t=>{
  topo=t;counties=t.objects.counties;geoms=counties.geometries;
  pool=buildPool();
  new ResizeObserver(resize).observe(cv);
  resize();
  const q=new URLSearchParams(location.search);
  // 隨機出題（每日一題設計 2026-08-31 移除，進 backlog）；?pair=南投縣,花蓮縣 可指定配對（測試／分享用）
  let pair=pool[Math.floor(Math.random()*pool.length)];
  const pq=q.get("pair");
  if(pq){
    // 容錯：臺→台（圖資用「台」）、去空白；找不到明講，別靜默換題
    const norm=s=>(s||"").trim().replace(/臺/g,"台");
    const [pa,pb]=pq.split(",").map(norm);
    const hit=pool.find(([i,j])=>{const s=[cname(geoms[i]),cname(geoms[j])];return s.includes(pa)&&s.includes(pb)});
    if(hit)pair=hit;
    else toast(`找不到「${pa} × ${pb}」這組相鄰縣市，改出隨機題`,3200);
  }
  loadRound(pair);
  // 第一次玩：提示模式的存在要被看見（Yo 裁定預設仍是自由畫，只做導流不改預設）
  if(!store.get("huajie.mode")&&!store.get("huajie.seen")&&!q.get("test")){
    store.set("huajie.seen","1");
    setTimeout(()=>toast("不知道界線從哪開始？右下角「提示」會標出兩端 ●",3600),900);
  }
  // 開發測試鉤子：?test=perfect|offset|chord 自動作答（&mode=easy|free 強制模式），供 headless 驗計分
  if(q.get("mode")==="easy"||q.get("mode")==="free"){mode=q.get("mode");updateHint()}
  // 白名單化：test 原值不進 document.title（資安審查 L2——去掉唯一的 URL 參數反射點）
  const testMode=["perfect","human","chord","offset","close","half","mirror","bulge"].includes(q.get("test"))?q.get("test"):null;
  if(testMode){setTimeout(()=>{
    // 八種畫法（給計分校準用）：perfect 完美描／close 差一點點／human 接近／offset 整條偏／half 前半對後半直線／chord 直線亂猜／mirror 形狀翻面／bulge 離譜大彎
    const B=resampleN(cur.borderPx,128),a0=anchors[0],a1=anchors[1];
    const cx=a1[0]-a0[0],cy=a1[1]-a0[1],cl=Math.hypot(cx,cy)||1,nx=-cy/cl,ny=cx/cl;   // 弦方向、法線
    let seed=[...(cname(cur.a)+cname(cur.b))].reduce((h,c)=>(h*31+c.charCodeAt(0))>>>0,7);  // 同題同結果
    const rnd=()=>{seed=(seed+0x6D2B79F5)>>>0;let t=seed;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296};
    const smooth=(P,k)=>P.map((p,i)=>{let sx=0,sy=0,n=0;for(let j=-k;j<=k;j++){const m=Math.max(0,Math.min(P.length-1,i+j));sx+=P[m][0];sy+=P[m][1];n++}return[sx/n,sy/n]});
    if(testMode==="chord"){
      pts=resampleN([a0.slice(),a1.slice()],64);
    }else if(testMode==="human"){
      // 仿真人：只記得大形狀（重度平滑）＋側偏 6px＋尾巴超畫 40px（Yo 2026-08-31 實玩特徵）
      const S=smooth(B,7).map(p=>[p[0]+6,p[1]+4]);
      const last=S[S.length-1],prev=S[S.length-4];
      const dx=last[0]-prev[0],dy=last[1]-prev[1],L=Math.hypot(dx,dy)||1;
      for(let k=1;k<=5;k++)S.push([last[0]+dx/L*k*8,last[1]+dy/L*k*8]);
      pts=S;
    }else if(testMode==="close"){
      // 差一點點：沿界線 ±4px 的平滑手抖
      let w=0;pts=smooth(B.map(p=>{w=Math.max(-4,Math.min(4,w+(rnd()-0.5)*2.5));return[p[0]+w*nx,p[1]+w*ny]}),2);
    }else if(testMode==="half"){
      pts=B.slice(0,64).concat([B[127].slice()]);            // 前半照描、後半偷懶拉直線
    }else if(testMode==="mirror"){
      pts=B.map(p=>{const d=(p[0]-a0[0])*nx+(p[1]-a0[1])*ny;return[p[0]-2*d*nx,p[1]-2*d*ny]});   // 形狀對但翻到弦的另一側
    }else if(testMode==="bulge"){
      const side=Math.sign(B.reduce((t,p)=>t+(p[0]-a0[0])*nx+(p[1]-a0[1])*ny,0))||1;             // 離譜：往界線反側鼓一個大彎
      pts=Array.from({length:64},(_,i)=>{const t=i/63,A=-side*0.35*cl*Math.sin(Math.PI*t);return[a0[0]+cx*t+A*nx,a0[1]+cy*t+A*ny]});
    }else{
      const off=+(q.get("off")||30);
      pts=cur.borderPx.map(p=>testMode==="offset"?[p[0]+off,p[1]+off*0.6]:p.slice());
      if(testMode==="offset"){pts[0]=cur.borderPx[0].slice();pts[pts.length-1]=cur.borderPx[cur.borderPx.length-1].slice()}
    }
    finish();
    document.title=`TEST ${testMode} ${mode} score=${cur.lastPct} raw=${cur.lastPctRaw}`;
    if(q.get("debug")){const d=computeScore().dbg;document.title+=" "+Object.entries(d).map(([k,v])=>`${k}=${v.toFixed(2)}`).join(" ")}
    if(q.get("card"))setTimeout(()=>{const img=new Image();img.src=buildShareCard().toDataURL("image/png");
      img.style.cssText="position:fixed;inset:0;width:100vw;height:100vh;object-fit:contain;background:#555;z-index:99";
      document.body.appendChild(img)},1500)
  },600)}
}).catch(()=>{
  // 人話＋重試（技術訊息如「topojson is not defined」只會誤導）
  const tk=$("#task");tk.textContent="地圖載入失敗——可能是網路不穩。";
  const b=document.createElement("button");b.textContent="重新載入";
  b.style.cssText="margin-left:10px;min-height:34px;padding:4px 14px";
  b.onclick=()=>location.reload();tk.appendChild(b);
});
window.addEventListener("resize",resize);
