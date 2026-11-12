# 可替换占位资源目录

本目录**当前为空占位**：项目运行时不读取这里任何文件，全部贴图由
`src/utils/textures.js` 在浏览器端程序化生成，全部模型由
`src/world/Cities.js` / `src/world/Characters.js` 程序化构造。

把写实素材放进对应子目录后，在 **`src/data/assets.js` 的 `ASSET_MANIFEST`**
里登记路径即可接入：已登记槽位会自动异步加载并替换程序化占位资源
（详见项目根目录 README「替换占位资源」）。

## 建议文件规格

```
textures/
  terrain_albedo_2048.jpg      地貌 + 州界 + 势力合成图（sRGB，2048²）
  terrain_normal_2048.jpg       地形法线（线性空间，无 sRGB）
  terrain_orm_2048.jpg          ORM 打包图（线性）：R=AO / G=roughness / B=metalness
                                登记到 ASSET_MANIFEST.terrainORM，一张图替换三个材质槽
  water_normals.jpg            无缝水面法线（可平铺，256/512²）
  bark_albedo.jpg / bark_normal.jpg
  stone_albedo.jpg / stone_normal.jpg
  roof_tile_albedo.jpg         中式青瓦
  leaf_atlas.png                叶片簇，带 alpha
  grass_atlas.png               草叶，带 alpha
models/
  general_<name>.glb            武将写实模型（Y 轴向上，单位米，含 PBR 材质）
  horse.glb                    战马
  city_<name>.glb               特殊都城建筑
audio/                          （预留）环境音 / 战鼓 / 雨雪
```

## 注意

- 贴图须为 **WebGL2 友好格式**（jpg / png / webp / ktx2）；法线与粗糙度贴图**不要**标记为 sRGB。
- GLB 模型原点建议在脚底，朝向 +Z，单位米；接入后按 `CONFIG.map.unitsPerDegree`
  与策略地图夸张比例做统一缩放。
- 所有替换点都是**可选**的：留空即自动走程序化占位资源，项目始终可独立运行。
