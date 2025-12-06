/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Monkeypatch @pmndrs/pointer-events RayIntersector to skip expensive UV recomputation
// during pointer capture. This keeps grabbing performant on dense meshes.

import {
  Plane,
  Vector3,
  Quaternion,
  Object3D,
  Sphere,
  Matrix4,
  InstancedMesh,
  Mesh,
} from '../runtime/index.js';
import {
  getVoidObject,
  Intersection,
  IntersectionOptions,
} from '@pmndrs/pointer-events';

type PointerCapture = { intersection: any; object: Object3D };

const planeHelper = new Plane();
const helperSphere: Sphere = new Sphere();

const rayDirectionHelperMap = new Map<any, Vector3>();
const pointerPositionHelperMap = new Map<any, Vector3>();
const pointerQuaternionHelperMap = new Map<any, Quaternion>();

const oldInputDevicePointOffset = new Vector3();
const inputDeviceQuaternionOffset = new Quaternion();

const vectorHelper = new Vector3();
const matrixHelper = new Matrix4();
const boxSizeHelper = new Vector3();
const boxCenterHelper = new Vector3();
const vec0_0001 = new Vector3(0.0001, 0.0001, 0.0001);
const invertedMatrixHelper = new Matrix4();

export function patchedIntersectRayPointerCapture(
  this: any,
  { intersection, object }: PointerCapture,
) {
  const details = intersection.details;
  if (details.type !== 'ray') {
    throw new Error(
      `unable to process a pointer capture of type "${details.type}" with a ray intersector`,
    );
  }
  if (!this.prepareTransformation()) {
    return intersection;
  }

  object.updateWorldMatrix(true, false);

  // Recompute the plane in world space using the stored localPoint and normal/face
  const normal = intersection.normal ?? intersection.face?.normal;
  if (normal != null && intersection.localPoint != null) {
    planeHelper.setFromNormalAndCoplanarPoint(normal, intersection.localPoint);
    planeHelper.applyMatrix4(object.matrixWorld);
  } else {
    // Fallback: face-on plane at previous world point
    planeHelper.setFromNormalAndCoplanarPoint(
      new Vector3(0, 0, 1),
      intersection.point,
    );
  }

  const { ray } = this.raycaster;
  const pointOnFace =
    ray.intersectPlane(planeHelper, new Vector3()) ?? intersection.point;

  let rayDirectionHelper = rayDirectionHelperMap.get(this);
  if (!rayDirectionHelper) {
    rayDirectionHelper = new Vector3();
    rayDirectionHelperMap.set(this, rayDirectionHelper);
  }

  let pointerPositionHelper = pointerPositionHelperMap.get(this);
  if (!pointerPositionHelper) {
    pointerPositionHelper = new Vector3();
    pointerPositionHelperMap.set(this, pointerPositionHelper);
  }

  let pointerQuaternionHelper = pointerQuaternionHelperMap.get(this);
  if (!pointerQuaternionHelper) {
    pointerQuaternionHelper = new Quaternion();
    pointerQuaternionHelperMap.set(this, pointerQuaternionHelper);
  }

  // Preserve distance along the ray from previous intersection
  const distanceAlongRay = intersection.pointerPosition.distanceTo(
    intersection.point,
  );
  const point = rayDirectionHelper
    .copy(ray.direction)
    .multiplyScalar(distanceAlongRay)
    .add(ray.origin);

  // NOTE: We intentionally skip UV recomputation here for performance.
  return {
    ...intersection,
    object,
    pointOnFace,
    point,
    pointerPosition: pointerPositionHelper.copy(ray.origin),
    pointerQuaternion: pointerQuaternionHelper.copy(this.raycasterQuaternion),
  };
}

export function patchedIntersectSpherePointerCapture(
  this: any,
  { intersection, object }: PointerCapture,
) {
  const details = intersection.details;
  if (details.type !== 'sphere') {
    throw new Error(
      `unable to process a pointer capture of type "${details.type}" with a ray intersector`,
    );
  }
  if (!this.prepareTransformation()) {
    return intersection;
  }

  //compute old inputDevicePosition-point offset
  oldInputDevicePointOffset
    .copy(intersection.point)
    .sub(intersection.pointerPosition);
  //compute oldInputDeviceQuaternion-newInputDeviceQuaternion offset
  inputDeviceQuaternionOffset
    .copy(intersection.pointerQuaternion)
    .invert()
    .multiply(this.fromQuaternion);

  //apply quaternion offset to old inputDevicePosition-point offset and add to new inputDevicePosition
  const point = oldInputDevicePointOffset
    .clone()
    .applyQuaternion(inputDeviceQuaternionOffset)
    .add(this.fromPosition);
  object.updateWorldMatrix(true, false);
  // Recompute the plane in world space using the stored localPoint and normal/face
  const normal = intersection.normal ?? intersection.face?.normal;
  if (normal != null && intersection.localPoint != null) {
    planeHelper.setFromNormalAndCoplanarPoint(normal, intersection.localPoint);
    planeHelper.applyMatrix4(object.matrixWorld);
  } else {
    // Fallback: face-on plane at previous world point
    planeHelper.setFromNormalAndCoplanarPoint(
      new Vector3(0, 0, 1),
      intersection.point,
    );
  }
  const pointOnFace = planeHelper.projectPoint(
    this.fromPosition,
    new Vector3(),
  );

  let pointerPositionHelper = pointerPositionHelperMap.get(this);
  if (!pointerPositionHelper) {
    pointerPositionHelper = new Vector3();
    pointerPositionHelperMap.set(this, pointerPositionHelper);
  }

  let pointerQuaternionHelper = pointerQuaternionHelperMap.get(this);
  if (!pointerQuaternionHelper) {
    pointerQuaternionHelper = new Quaternion();
    pointerQuaternionHelperMap.set(this, pointerQuaternionHelper);
  }

  // NOTE: We intentionally skip UV recomputation here for performance.
  return {
    details: {
      type: 'sphere',
    },
    distance: point.distanceTo(pointOnFace),
    pointerPosition: pointerPositionHelper.copy(this.fromPosition),
    pointerQuaternion: pointerQuaternionHelper.copy(this.fromQuaternion),
    object,
    point,
    pointOnFace,
    face: intersection.face,
    localPoint: intersection.localPoint,
  };
}

function maximizeAxisVector(vec: Vector3) {
  const absX = Math.abs(vec.x);
  const absY = Math.abs(vec.y);
  const absZ = Math.abs(vec.z);
  if (absX >= absY && absX >= absZ) {
    //x biggest
    vec.set(vec.x < 0 ? -1 : 1, 0, 0);
    return;
  }
  if (absY >= absX && absY >= absZ) {
    //y biggest
    vec.set(0, vec.y < 0 ? -1 : 1, 0);
    return;
  }
  //z biggest
  vec.set(0, 0, vec.z < 0 ? -1 : 1);
}

function patchedIsSphereIntersectingMesh(
  pointerSphere: any,
  { geometry }: Mesh,
  meshMatrixWorld: Matrix4,
) {
  if (geometry.boundingSphere == null) {
    geometry.computeBoundingSphere();
  }
  helperSphere
    .copy(geometry.boundingSphere ?? new Sphere())
    .applyMatrix4(meshMatrixWorld);
  return (
    helperSphere.center.distanceToSquared(pointerSphere.center) <
    (pointerSphere.radius + helperSphere.radius) ** 2
  );
}

function patchedIntersectSphereWithObject(
  pointerSphere: any,
  object: Object3D,
  target: any,
) {
  object.updateWorldMatrix(true, false);
  if (object.spherecast != null) {
    object.spherecast(pointerSphere, target);
    return;
  }
  if (object instanceof InstancedMesh) {
    if (object.geometry.boundingSphere == null) {
      object.geometry.computeBoundingSphere();
    }
    if (object.geometry.boundingBox == null) {
      object.geometry.computeBoundingBox();
    }
    for (let i = 0; i < object.count; i++) {
      object.getMatrixAt(i, matrixHelper);
      matrixHelper.premultiply(object.matrixWorld);
      if (
        !patchedIsSphereIntersectingMesh(pointerSphere, object, matrixHelper)
      ) {
        continue;
      }
      const intersection = patchedIntersectSphereMesh(
        pointerSphere,
        object,
        matrixHelper,
        i,
      );
      if (intersection == null) {
        continue;
      }
      target.push(intersection);
    }
  }
  if (!(object instanceof Mesh)) {
    return;
  }
  if (
    !patchedIsSphereIntersectingMesh(pointerSphere, object, object.matrixWorld)
  ) {
    return;
  }
  invertedMatrixHelper.copy(object.matrixWorld).invert();
  const intersection = patchedIntersectSphereMesh(
    pointerSphere,
    object,
    object.matrixWorld,
  );
  if (intersection == null) {
    return;
  }
  target.push(intersection);
}

function patchedIntersectSphereMesh(
  pointerSphere: any,
  mesh: Mesh,
  meshMatrixWorld: Matrix4,
  instanceId?: number,
) {
  invertedMatrixHelper.copy(meshMatrixWorld).invert();
  helperSphere.copy(pointerSphere).applyMatrix4(invertedMatrixHelper);
  const { geometry } = mesh;
  if (geometry.boundingBox == null) {
    geometry.computeBoundingBox();
  }
  geometry.boundingBox?.getSize(boxSizeHelper);
  geometry.boundingBox?.getCenter(boxCenterHelper);
  geometry.boundingBox?.clampPoint(helperSphere.center, vectorHelper);
  vectorHelper.applyMatrix4(meshMatrixWorld); //world coordinates
  const distanceToSphereCenterSquared = vectorHelper.distanceToSquared(
    pointerSphere.center,
  );
  if (
    distanceToSphereCenterSquared >
    pointerSphere.radius * pointerSphere.radius
  ) {
    return undefined;
  }
  boxSizeHelper.max(vec0_0001);
  const normal = helperSphere.center.clone().sub(boxCenterHelper);
  normal.divide(boxSizeHelper);
  maximizeAxisVector(normal);
  const point = vectorHelper.clone();

  return {
    distance: Math.sqrt(distanceToSphereCenterSquared),
    face: {
      a: 0,
      b: 0,
      c: 0,
      materialIndex: 0,
      normal,
    },
    normal,
    point,
    instanceId,
    object: mesh,
  };
}

export function patchedExecuteIntersection(
  this: any,
  object: Object3D,
  objectPointerEventsOrder: number | undefined,
) {
  if (!this.isReady()) {
    return;
  }
  const start = this.intersects.length;
  if (!this.pointerEventsOrders) {
    this.pointerEventsOrders = [];
  }
  patchedIntersectSphereWithObject(
    this.collisionSphere,
    object,
    this.intersects,
  );
  pushTimes(
    this.pointerEventsOrders,
    objectPointerEventsOrder,
    this.intersects.length - start,
  );
}

function pushTimes<T>(target: Array<T>, value: T, times: number): void {
  while (times > 0) {
    target.push(value);
    --times;
  }
}

export function patchedFinalizeIntersection(
  this: any,
  scene: Object3D,
): Intersection {
  const pointerPosition = this.fromPosition.clone();
  const pointerQuaternion = this.fromQuaternion.clone();

  const index = getDominantIntersectionIndex(
    this.intersects,
    this.pointerEventsOrders,
    this.options,
  );
  const intersection = index == null ? undefined : this.intersects[index];
  this.intersects.length = 0;

  if (intersection == null) {
    return {
      details: {
        type: 'sphere' as const,
      },
      distance: 0,
      point: pointerPosition,
      object: getVoidObject(scene),
      pointerPosition,
      pointerQuaternion,
      pointOnFace: pointerPosition,
      localPoint: pointerPosition,
    };
  }

  intersection.object.updateWorldMatrix(true, false);

  return Object.assign(intersection, {
    details: {
      type: 'sphere' as const,
    },
    pointOnFace: intersection.point,
    pointerPosition: this.fromPosition.clone(),
    pointerQuaternion: this.fromQuaternion.clone(),
    localPoint: intersection.point
      .clone()
      .applyMatrix4(
        invertedMatrixHelper.copy(intersection.object.matrixWorld).invert(),
      ),
  });
}

export function getDominantIntersectionIndex<T extends Intersection>(
  intersections: Array<T>,
  pointerEventsOrders: Array<number | undefined>,
  { customSort: compare = defaultSort as any }: IntersectionOptions = {},
  filter?: (intersection: Intersection) => boolean,
): number | undefined {
  let intersection: T | undefined = undefined;
  let pointerEventsOrder: number | undefined = undefined;
  let index: number | undefined = undefined;
  const length = intersections.length;
  for (let i = 0; i < length; i++) {
    const newIntersection = intersections[i];
    if (filter?.(newIntersection) === false) {
      continue;
    }
    const newPointerEventsOrder = pointerEventsOrders[i];
    if (
      intersection == null ||
      compare(
        newIntersection,
        newPointerEventsOrder,
        intersection,
        pointerEventsOrder,
      ) < 0
    ) {
      index = i;
      intersection = newIntersection;
      pointerEventsOrder = newPointerEventsOrder;
    }
  }
  return index;
}

/**
 * @returns a negative number if i1 should be sorted before i2
 */
function defaultSort(
  i1: Intersection,
  pointerEventsOrder1: number = 0,
  i2: Intersection,
  pointerEventsOrder2: number = 0,
): number {
  if (pointerEventsOrder1 != pointerEventsOrder2) {
    //inverted order because order is sorted highest first
    return pointerEventsOrder2 - pointerEventsOrder1;
  }
  //i1 - i2 because negative values mean the sorting i1 before i2 is correct
  return i1.distance - i2.distance;
}
