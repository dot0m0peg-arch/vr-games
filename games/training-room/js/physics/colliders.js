// Capture each primitive before render batching so table legs do not become a solid box.
import * as THREE from '../../vendor/three.module.min.js';
export function colliderShapes(root, scale=1) {
  root.updateWorldMatrix(true,true);
  const inverse=root.parent?root.parent.matrixWorld.clone().invert():new THREE.Matrix4();
  const shapes=[];
  root.traverse(mesh=>{
    if(!mesh.isMesh||mesh.userData.phaseHelper||!mesh.visible||!mesh.geometry) return;
    const g=mesh.geometry;
    if(!g.boundingBox)g.computeBoundingBox();
    if(!g.boundingBox||g.boundingBox.isEmpty())return;
    const m=new THREE.Matrix4().multiplyMatrices(inverse,mesh.matrixWorld);
    const p=new THREE.Vector3(),q=new THREE.Quaternion(),s=new THREE.Vector3();m.decompose(p,q,s);
    const center=g.boundingBox.getCenter(new THREE.Vector3()).applyMatrix4(m).multiplyScalar(scale);
    const size=g.boundingBox.getSize(new THREE.Vector3()).multiply(s).multiplyScalar(scale);
    for(const k of ['x','y','z'])size[k]=Math.max(.005,Math.abs(size[k]));
    const material=Array.isArray(mesh.material)?mesh.material[0]:mesh.material;
    const sphere=g.type==='SphereGeometry'&&Math.max(size.x,size.y,size.z)-Math.min(size.x,size.y,size.z)<.005;
    // material: what the solver and the stick rule read (physics table). surface: the kit look family the mesh was built
    // from (straw, plank, steel, rock...), which the contact effects read (LOOK-BIBLE.md section 7). Step 6, Oct 26 2026.
    shapes.push({p:{x:center.x,y:center.y,z:center.z},q:{x:q.x,y:q.y,z:q.z,w:q.w},
      size:{x:size.x,y:size.y,z:size.z},shape:sphere?'ball':'box',material:material?.userData?.phys??material?.userData?.kind??'wood',
      surface:material?.userData?.kind??material?.userData?.phys??'wood'});
  });
  return shapes;
}
