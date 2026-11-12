/**
 * 三维地形：高精度高度场网格 + PBR 三图 + 季节 / 物理湿润 shader
 * ---------------------------------------------------------------------------
 * 版图信息（州界、州名、官道、势力疆界）烘焙在同一张贴图上，因此永远
 * 完美贴合山峦起伏，不会出现浮空/穿模，也几乎没有额外 draw call。
 *
 * 照片级材质要点（借鉴 fable52-fps-repro）：
 *  · ormMap 为 ORM 打包贴图，同时绑定 aoMap(R) / roughnessMap(G) / metalnessMap(B)；
 *    AO 由高度场离线烘焙（山谷、河谷、沟壑的接触遮蔽），运行时零 GPU 开销。
 *  · 逐像素 roughness：水面、滩涂、湿地、草地、裸岩的高光尺度完全不同。
 *  · 雨天走「水膜物理」：反照率降到 55% + 粗糙度下降 + 法线压平 + 菲涅尔天空反射，
 *    低洼平地形成浅积水镜面；不再是简单的一层灰。
 */
import * as THREE from 'three';
import { CONFIG, SEASONS } from '../config.js';
import { MAP_W, MAP_H, heightAt } from './geo.js';
import { buildTerrainTextures, makeStone } from '../utils/textures.js';
import { ASSET_MANIFEST, loadOptionalTexture } from '../data/assets.js';

export class Terrain {
  constructor(scene, quality) {
    this.scene = scene;
    this.uniforms = {
      uSeasonTint: { value: new THREE.Vector3(...SEASONS[CONFIG.season].tint) },
      uSnowLine: { value: SEASONS[CONFIG.season].snowLine },
      uWinter: { value: CONFIG.season === '冬' ? 1 : 0.22 },
      uWet: { value: 0 },
      uSkyColor: { value: new THREE.Color(0x8fb9d6) },
      uWetDarken: { value: CONFIG.material.wetDarken },
      uWetRoughness: { value: CONFIG.material.wetRoughness },
      uWetReflect: { value: CONFIG.material.wetReflect },
    };
    this.build(quality);
  }

  build(quality) {
    const seg = quality.isMobile ? CONFIG.terrain.segmentsMobile : CONFIG.terrain.segments;
    const geo = new THREE.PlaneGeometry(MAP_W, MAP_H, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, heightAt(pos.getX(i), pos.getZ(i)));
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingSphere();

    const tex = buildTerrainTextures();
    this.thumbnail = tex.thumbnail;
    const maxAniso = quality.maxAnisotropy || 8;
    tex.map.anisotropy = Math.min(16, maxAniso);
    tex.normalMap.anisotropy = Math.min(8, maxAniso);
    tex.ormMap.anisotropy = Math.min(8, maxAniso);

    const mat = new THREE.MeshStandardMaterial({
      map: tex.map,
      normalMap: tex.normalMap,
      normalScale: new THREE.Vector2(0.28, 0.28),
      // 一张 ORM 贴图服务三个槽位：R=AO, G=roughness, B=metalness
      aoMap: tex.ormMap,
      roughnessMap: tex.ormMap,
      metalnessMap: tex.ormMap,
      aoMapIntensity: CONFIG.material.aoMapIntensity,
      roughness: 1.0,
      metalness: 1.0,
      dithering: true,
    });

    // 注入季节调色 / 动态雪线 / 物理湿润，全部在 GPU 上完成，切换零开销
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWorldPosT;\nvarying vec3 vWorldNormalT;')
        .replace('#include <beginnormal_vertex>',
          '#include <beginnormal_vertex>\n vWorldNormalT = normalize(mat3(modelMatrix) * objectNormal);')
        .replace('#include <begin_vertex>',
          '#include <begin_vertex>\n vWorldPosT = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vWorldPosT;
          varying vec3 vWorldNormalT;
          uniform vec3 uSeasonTint;
          uniform vec3 uSkyColor;
          uniform float uSnowLine;
          uniform float uWinter;
          uniform float uWet;
          uniform float uWetDarken;
          uniform float uWetRoughness;
          uniform float uWetReflect;
          float gPuddle;`)
        .replace('#include <map_fragment>', `#include <map_fragment>
          // 依植被绿色权重做季节色相迁移，岩石与夯土受影响较小
          float vegW = smoothstep(0.02, 0.20, diffuseColor.g - diffuseColor.r * 0.62);
          vec3 tint = mix(vec3(1.0), uSeasonTint, vegW * 0.85);
          diffuseColor.rgb *= tint;
          // 雪线随季节升降，噪声让雪缘自然破碎
          float hN = vWorldPosT.y
                   + sin(vWorldPosT.x * 0.29 + vWorldPosT.z * 0.13) * 1.9
                   + cos(vWorldPosT.z * 0.41 - vWorldPosT.x * 0.09) * 1.3;
          float snowM = smoothstep(uSnowLine * 40.0, uSnowLine * 40.0 + 8.0, hN) * uWinter;
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.87, 0.90, 0.94), snowM * 0.90);
          // 湿润反照率衰减：水填充土壤孔隙，地面变深而非变灰
          diffuseColor.rgb *= mix(1.0, uWetDarken, uWet);
          // 低洼平地形成浅积水，噪声打散水岸线
          float lowland = 1.0 - smoothstep(3.0, 10.0, vWorldPosT.y);
          float flatness = smoothstep(0.86, 0.985, vWorldNormalT.y);
          float brk = 0.5 + 0.5 * sin(vWorldPosT.x * 0.83 + vWorldPosT.z * 0.57)
                          * cos(vWorldPosT.z * 1.13 - vWorldPosT.x * 0.31);
          gPuddle = smoothstep(0.42, 0.86, uWet) * flatness * lowland
                  * smoothstep(0.35, 0.72, brk);
          diffuseColor.rgb *= mix(1.0, 0.62, gPuddle);`)
        // 湿润 -> 粗糙度下降；积水 -> 接近镜面
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          roughnessFactor = mix(roughnessFactor, roughnessFactor * uWetRoughness, uWet);
          roughnessFactor = mix(roughnessFactor, 0.045, gPuddle * 0.92);`)
        // 水面平静：积水处法线几乎拉平，保留少量微起伏
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
          normal = normalize(mix(normal, nonPerturbedNormal, clamp(gPuddle * 0.94 + uWet * 0.10, 0.0, 0.97)));`)
        // 菲涅尔天空反射注入 PBR 的 indirectSpecular（不绕过色彩管理）
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
          {
            float NoV = clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
            float fr = 0.03 + 0.97 * pow(1.0 - NoV, 5.0);
            float rw = 1.0 - clamp(roughnessFactor, 0.0, 1.0);
            rw *= rw;
            // 反射天空比天空本身暗（能量守恒），避免雨景整片泛白
            reflectedLight.indirectSpecular += uSkyColor * 0.68 * fr * rw
              * (uWet * 0.24 + gPuddle * 0.76) * uWetReflect;
          }`);
    };
    mat.customProgramCacheKey = () => 'terrain-pbr-wet-v2';

    // 真实扫描贴图（若已登记）会在后台加载完成后自动替换程序化占位贴图
    loadOptionalTexture(ASSET_MANIFEST.terrainMap, { srgb: true, aniso: 16 },
      (t) => { mat.map = t; mat.needsUpdate = true; });
    loadOptionalTexture(ASSET_MANIFEST.terrainNormal, { aniso: 8 },
      (t) => { mat.normalMap = t; mat.needsUpdate = true; });
    loadOptionalTexture(ASSET_MANIFEST.terrainORM, { aniso: 8 },
      (t) => {
        mat.aoMap = t; mat.roughnessMap = t; mat.metalnessMap = t;
        mat.needsUpdate = true;
      });

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = 'terrain';
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.mesh.userData.pickType = 'terrain';
    this.scene.add(this.mesh);

    // 地形底座：深色岩质剖面，避免低角度看到地图边缘悬空
    const stone = makeStone(256);
    const baseMat = new THREE.MeshStandardMaterial({
      map: stone.map, normalMap: stone.normalMap,
      aoMap: stone.orm, roughnessMap: stone.orm, metalnessMap: stone.orm,
      aoMapIntensity: 0.7, color: 0x4a4038,
      roughness: 1.0, metalness: 1.0,
    });
    const base = new THREE.Mesh(new THREE.BoxGeometry(MAP_W + 3, 22, MAP_H + 3), baseMat);
    base.position.y = CONFIG.map.seaLevel - 14;
    base.receiveShadow = true;
    this.scene.add(base);

    this.material = mat;
  }

  /** 平滑过渡到目标季节 / 天气（每帧调用，避免突变） */
  updateSeason(season, weather, dt, env) {
    const s = SEASONS[season];
    const target = s.tint;
    const u = this.uniforms;
    const k = Math.min(1, dt * 1.6);
    u.uSeasonTint.value.x += (target[0] - u.uSeasonTint.value.x) * k;
    u.uSeasonTint.value.y += (target[1] - u.uSeasonTint.value.y) * k;
    u.uSeasonTint.value.z += (target[2] - u.uSeasonTint.value.z) * k;
    u.uSnowLine.value += (s.snowLine - u.uSnowLine.value) * k;
    const winterTarget = season === '冬' ? 1 : 0.22;
    u.uWinter.value += (winterTarget - u.uWinter.value) * k;
    const wetTarget = weather === '雨' ? 1 : weather === '阴' ? 0.30 : 0;
    u.uWet.value += (wetTarget - u.uWet.value) * k;
    // 湿地面反射的是当时的天空色，随昼夜/天气联动
    if (env?.skyColor) u.uSkyColor.value.lerp(env.skyColor, Math.min(1, dt * 2.0));
  }

  groundY(x, z) { return heightAt(x, z); }
}
