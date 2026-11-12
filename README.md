# 三国志 · 汉末十三州 — three.js 三维策略舆图原型

以汉末十三州州郡版图为底图的可运行三维策略地图原型。全部资源在浏览器端程序化生成，**克隆后无需下载任何模型/贴图即可运行**；同时预留了完整的写实素材替换接口。

## 运行

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # 产出 dist/（base='./'，可直接放任意静态目录）
npm run preview   # 预览构建产物
```

要求 Node 18+，支持 WebGL2 的现代浏览器（Chrome / Edge / Safari 16+）。首次进入约需 3–8 秒生成地形与贴图，载入页会显示进度。

## 在线预览（GitHub Pages）

**https://let5sne.github.io/sanguozhi-3d-strategy/**

仓库：<https://github.com/let5sne/sanguozhi-3d-strategy>（公开）。`main` 分支存放源码，`gh-pages` 分支只存放构建产物 `dist/`，GitHub Pages 以该分支根目录托管；`vite.config.js` 的 `base: './'` 已适配项目子路径，因此同一个 `dist/` 在本地静态目录、Pages 或其他子路径下都能直接打开。

修改代码后重新部署：

```bash
npm run build
npm run deploy:pages     # 构建并把 dist/ 强制推送到 gh-pages 分支
```

调试参数同样适用于线上版本，例如 `?tier=low&lite=1&noauto=1&hour=18&season=冬&weather=雪`、`?film=0`（关闭电影调色层做 A/B 对比）。

## 已实现

| 类别 | 内容 |
| --- | --- |
| 地图 | 汉末十三州（含司隶）简化州界、~50 座城池、势力疆界（噪声扰动 Voronoi）、官道、州名题注，全部烘焙进同一张 2048² 贴图，随山势贴合 |
| 地形 | 384² 高度场 + 256 段网格；秦岭 / 太行 / 大巴 / 南岭 / 横断等真实走向山脉；河谷 U 形下切、湖盆、海岸沉降、四川盆地与华北平原 |
| 水体 | 东海平面镜反射（three.js Water）、黄河 / 长江 / 汉水 / 渭水 / 淮河等 12 条流动河道、六大湖泊；双层法线滚动 + 菲涅尔 + 太阳高光 + 雾 |
| 城池 | 夯土城墙、垛口、角楼、朱漆城门、庑殿顶重檐城楼、院落、华表、灯笼夜光、四势力旌旗（GPU 迎风摆动） |
| 人物 / 动物 | 13 位武将（兜鍪、山文甲、披风、长兵 / 羽扇 / 弓）、9 处士兵方阵、写实比例战马、河西牧场马群、山林鹿群 |
| 植被 | 松 / 阔叶 / 垂柳三种写实树冠（alpha 叶片簇 + PBR 树皮）、上万株摆动草丛、山脉裸岩 |
| 光照 | Preetham 大气散射天空、PMREM 环境反射 IBL、线性 HDR + ACES 色调映射、SMAA、FilmGrade 电影调色、PCF 柔和阴影、SSAO、景深、HDR 阈值泛光、指数雾、星空与月亮、夜间 HDR 灯火 |
| 动态 | 24 时辰自动昼夜（十二时辰显示 + 时间轴拖拽）、春 / 夏 / 秋 / 冬（植被色相、雪线、日照角）、晴 / 阴 / 雨 / 雪（云幕、雨雪粒子、辐照度与雾） |
| 交互 | 旋转 / 缩放 / 平移、点选城池 / 武将 / 军团 / 州郡并展示志书、小地图点击移师、名签投影去重、势力图例开关、镜头复位、快捷键 |
| 适配 | 设备能力分档 + 连续掉帧自动降档、移动 / 桌面实例数量分级、低画质关闭反射 / SSAO / 景深、响应式 HUD、触屏双指手势 |

## 交互

- **左键拖拽**旋转 / **右键拖拽**平移 / **滚轮**缩放；触屏单指旋转、双指缩放平移
- **单击** 城池、武将、军团或山川 → 右侧信息志；**单击城池名签** → 视角移师
- **W A S D / 方向键** 移动，**Q E** 旋转，**R** 复位，**L** 名签开关，**空格** 自动昼夜，**1–4** 切季
- 底部控制台：时辰时间轴、四季、天气、画质档位、昼夜、复位、名签
- 左下小地图点击可直接跳到相应州郡

## 项目结构

```
src/
├── main.js                 # 入口：分帧初始化、主循环、全局 handlers、ASSET_MANIFEST
├── config.js                # ★ 所有可调参数：尺度/画质/人口/相机/季节/天气/势力配色
├── core/
│   ├── Lighting.js          # 天空、太阳、阴影、昼夜四季、PMREM IBL、env 输出
│   ├── PostFX.js            # 线性 HDR 链：Render→SSAO→Bokeh→Bloom→SMAA→Output→FilmGrade
│   ├── CameraRig.js         # OrbitControls 封装、飞行、键盘、边界约束
│   ├── Picker.js            # 射线点选 + 选中光环
│   └── Quality.js           # 设备分档、像素预算、帧率自适应
├── world/
│   ├── geo.js               # ★ 经纬度投影、高度场、坡度、势力 / 州郡查询
│   ├── Terrain.js           # 地形网格 + ORM 三图 + 季节 / 物理湿润 shader
│   ├── Water.js             # 海 / 河 / 湖（菲涅尔 + HDR 高光）
│   ├── Cities.js            # 城池与旌旗（合批 + 顶点色伪 AO + ORM）
│   ├── Characters.js        # 武将 / 士兵 / 战马 / 鹿
│   ├── Vegetation.js        # 树 / 草 / 岩（实例化）
│   └── Weather.js           # 云幕与雨雪粒子
├── data/
│   ├── map.js               # ★ 州界、城池、河流、湖泊、海岸、山脉（可直接换 GeoJSON）
│   ├── generals.js          # ★ 武将五维与列传
│   └── assets.js            # ★ 可替换资源清单 ASSET_MANIFEST + 异步加载器
├── utils/
│   ├── noise.js             # 确定性 value noise / fbm / ridged
│   └── textures.js          # ★ 全部程序化 PBR 贴图工厂（含 ORM 打包 / 高度场烘焙 AO）
└── ui/
    ├── HUD.js               # 图例、控件、信息志、名签投影
    ├── Minimap.js           # 小地图
    └── style.css            # 古风响应式样式
```

## 照片级渲染：从 fable52-fps-repro 迁移的技术

参考 `/Users/yuanjiantsui/dev/02-ai/fable52-fps-repro`（`demos/02-materials`、`03-models`、`04-fps`）逐行分析后，确认它的写实感**不来自更多多边形或更亮的太阳**，而来自下面这套可复用的工程方法。本项目已全部落地：

| # | 参考项目做法 | 本项目落地位置 | 效果 |
| --- | --- | --- | --- |
| 1 | **ORM 三图打包**：一张线性贴图 R=AO / G=roughness / B=metalness，同时绑 `aoMap`/`roughnessMap`/`metalnessMap`；逐像素 roughness 是写实感第一来源 | `utils/textures.js` 的 `buildBiomeBase()` / `buildORM()`；`world/Terrain.js`、`Cities.js`、`Vegetation.js` | 水面、滩涂、湿地、草地、裸岩、砖缝、瓦沟的高光尺度各不相同，消除「塑料平涂」 |
| 2 | **把 AO 烘进贴图**而不是每帧算屏幕空间 AO | `bakeTerrainAO()`：8 方向多尺度地平线搜索 + 局部凹陷曲率 | 山谷、河谷、沟壑有稳定接触遮蔽，零 GPU 开销 |
| 3 | **线性 HDR 色彩科学**：HalfFloat RT 全链 + ACES + `OutputPass` 统一转换 + 阈值 >1 的 Bloom | `core/PostFX.js` | HDR 高光柔和滚降；只有灯火 / 水面日照碎金起辉，白天不再整片发白 |
| 4 | **显示参考空间调色层**（在 `OutputPass` 之后）：分离调色 / S 曲线 / 暗角 / 胶片颗粒 / 径向色差 | `PostFX.js` 的 `FilmGradeShader` | 暗部冷青、亮部暖金（绢帛与日光），把「干净渲染」变成「镜头成像」。本项目 HUD 是 DOM，不受影响 |
| 5 | **物理湿润 / 积水**：反照率降到 55%、粗糙度下降、法线压平 94%、菲涅尔天空反射注入 `indirectSpecular` | `world/Terrain.js` 的 shader 注入 | 雨天地面变深且有反光，低洼形成浅积水，不再是一层灰 |
| 6 | **菲涅尔 + HDR 高光 + 防过亮钳制**的水面；F0=0.02、`min(spec, 3.6)` | `world/Water.js` 的 `FLOW_FRAG` | 掠射角才强反射；顺流白沫只出现在波峰且随日照衰减（修掉了夜间整条河泛白） |
| 7 | **顶点色伪 AO**（`Kit.shade`）+ HDR emissive 发光体 | `world/Cities.js` 的 `withShade()`、夜间灯火强度 7.2 | 合批建筑仍有部件明暗与底部遮蔽；灯火成为真正的光源而非贴纸 |
| 8 | **SMAA / 阴影尺度自适应 / 静态阴影分频 / 像素预算 DPR / 预热编译** | `PostFX.js`、`Lighting.js`（`normalBias = span*0.0027`）、`Quality.js`、`main.js` | 消除锯齿与 shadow acne；4K 屏按 290 万像素预算降采样；首帧不卡顿 |

**A/B 对比与调试参数**

```text
?film=0           关闭电影调色层，直接对比升级前后
?tier=high|medium|low&lite=1&noauto=1&hour=18&season=冬&weather=雪
```

调色层参数、ORM / AO / 湿润强度、Bloom 阈值、雾倍数、像素预算全部集中在 `src/config.js` 的
`post` / `material` / `lighting` 段，可直接调风格而不用改 shader。

**为什么还做不到真正的照片级**：参考项目同样受限于纯程序化资产。人物面部、树冠、
织物与砖石的微观几何仍无法等同摄影测量扫描；继续升级的优先级是
① 替换为 KTX2 压缩的实景 PBR 贴图（接口已就绪）② GLB 扫描模型 ③ 近景水面的
平面反射 RT（当前东海已用 `Water`，河湖为轻量 shader，见下方「可选进阶」）。

**可选进阶：河湖的平面反射**（参考 `02-materials` / `04-fps` 的镜像相机 + `textureLod(rt, uv, roughness*7)`）
当前未启用，因为大地图每帧多渲染一遍全场景代价过高。若要加：只在镜头贴近水面时开启、
RT 降到 1/4 分辨率、隔帧更新、用反射专用 layer 只渲染岸线与城池，并补 oblique 近平面裁剪。

## 替换占位资源

项目**不使用任何外部图片/模型**，所有贴图由 `src/utils/textures.js` 用 Canvas 生成（可平铺、带 mipmap 与各向异性过滤），人物/城池为程序化网格。要升级到照片级扫描素材：

1. 把真实资源放进 `public/assets/`（目录已备好，见其中说明）。
2. 在 **`src/data/assets.js` 的 `ASSET_MANIFEST`** 登记路径。目前 `terrainMap` / `terrainNormal` / **`terrainORM`**（推荐，一张图同时替换 AO/粗糙度/金属度）/ `terrainRoughness`（旧称）/ `waterNormals` / `leafAtlas` / `bark` / `roofTile` 已接好异步加载器：登记后自动替换对应材质槽，加载失败则静默回退到程序化资源，不会白屏。**数据贴图（normal / ORM）必须保持线性色彩空间**（加载器默认不设 sRGB），否则 AO 与粗糙度会被 gamma 破坏。
3. 武将模型在 `data/generals.js` 的 `model` 字段登记 GLB 路径（需自行在 `Characters.js` 里接入 `GLTFLoader`，该字段为预留接口）。
4. 州郡与城池数据：`src/data/map.js` 换成真实历史 GIS（GeoJSON polygon + 城址表），投影层 `geo.js` 无需改动。

**关于「照片级写实」**：本原型以 ORM 三图 + 烘焙 AO + 线性 HDR 色彩科学 + 电影调色 + 物理湿润/水面菲涅尔逼近写实观感（详见上一节），但程序化几何（尤其人物面部与树冠）无法等同摄影测量扫描资产。制作级品质需要替换为真实扫描模型 / 实景贴图，替换点已全部集中并注释。

## 性能策略

- 城池 50 座 → 5 个合批 Mesh；旌旗 4 个；人物 5 个；树/草/岩/士兵/马群各 1–4 个 InstancedMesh；总 draw call 约 30–40
- 版图州界 / 势力 / 官道 / **烘焙 AO** 全部进地形贴图，零额外 draw call 且天然贴合起伏
- 阴影相机跟随镜头焦点维持高精度；`normalBias` 按阴影包围盒尺度自适应；移动端 1024、桌面 2048
- 阴影贴图由主循环分频驱动（high 每帧、medium/low 隔帧），静态地形不重复烘焙
- 像素比按 **290 万总像素预算**自适应，4K 屏自动降采样；连续 2.5 秒低于 40 FPS 再降一档
- 高画质才启用平面反射 / SSAO / 景深 / SMAA；低画质只保留 RenderPass + OutputPass + FilmGrade
- 首帧前 `renderer.compile()` 预热全部 shader program 与贴图，避免切换昼夜 / 首次点选时卡顿
- 雨雪粒子与旗帜 / 草丛 / 披风动画全在 GPU 顶点着色器完成，无 CPU 逐帧更新
- PMREM 环境贴图按 2.4 秒节流刷新，昼夜过渡平滑但不每帧重算

## 数据说明

城池经纬度为 WGS84 近似值，州界为简化多边形，兵粮 / 五维数值与武将传记均为**演示用占位内容**，非史实考据；势力格局取三国鼎立时期（魏据中原河北、蜀据益州汉中、吴据荆扬交广）。
