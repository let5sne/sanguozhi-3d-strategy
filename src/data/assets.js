/**
 * 可替换资源清单 + 异步加载器
 * ---------------------------------------------------------------------------
 * 所有字段默认 null —— 项目完全用程序化贴图 / 几何运行，不依赖任何外部文件。
 * 把真实素材放进 public/assets/ 并在此登记相对路径（如 '/assets/textures/x.jpg'），
 * 对应模块会在后台加载成功后自动替换材质槽；加载失败则静默保留程序化占位资源。
 */
import * as THREE from 'three';

export const ASSET_MANIFEST = {
  terrainMap: null,        // 2048² 地貌 + 州郡 + 势力合成图（sRGB）
  terrainNormal: null,      // 地形微表面法线（线性）
  terrainORM: null,         // ORM 打包图（线性）：R=AO / G=roughness / B=metalness
  terrainRoughness: null,   // 兼容旧称：单独粗糙度图（推荐改用 terrainORM）
  waterNormals: null,       // 无缝水面法线（可平铺）
  leafAtlas: null,          // 叶片簇 RGBA（带 alpha）
  bark: null,               // 树皮 albedo
  roofTile: null,           // 中式青瓦 albedo
  generalModels: {},        // { '关羽': '/assets/models/guanyu.glb' } 预留给 GLTFLoader
};

let _loader;
/** 加载成功回调里替换材质；失败时保留程序化资源，不影响运行 */
export function loadOptionalTexture(path, options = {}, onReady) {
  if (!path) return;
  const { srgb = false, repeat = null, aniso = 8 } = options;
  _loader = _loader || new THREE.TextureLoader();
  _loader.load(
    path,
    (t) => {
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      if (repeat) {
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(repeat[0], repeat[1]);
      }
      t.anisotropy = aniso;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.generateMipmaps = true;
      t.needsUpdate = true;
      onReady?.(t);
    },
    undefined,
    (err) => console.warn('[Assets] 素材加载失败，继续使用程序化占位资源：', path, err)
  );
}
