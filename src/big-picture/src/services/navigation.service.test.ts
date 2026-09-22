import assert from "node:assert/strict";
import { test } from "node:test";
import { NavigationService } from "./navigation.service.js";

const setup = () => {
  const navigation = new NavigationService();
  navigation.registerRegion({
    id: "row",
    parentRegionId: null,
    orientation: "horizontal",
    getElement: () => null,
  });
  return navigation;
};

test("publishes one snapshot for a synchronous mount, while focus resolves immediately", async () => {
  const navigation = setup();
  let notifications = 0;
  navigation.subscribe(() => notifications++);
  for (let i = 0; i < 1000; i++) {
    navigation.registerNavigationNode({
      id: String(i),
      regionId: "row",
      getElement: () => null,
    });
  }
  assert.equal(navigation.getCurrentFocusId(), "0");
  assert.equal(navigation.moveFocus("right"), "1");
  await Promise.resolve();
  assert.equal(notifications, 1);
});

test("preserves explicit order, ties, disabled nodes and order changes", () => {
  const navigation = setup();
  const add = (id: string, navigationOrder?: number) =>
    navigation.registerNavigationNode({
      id,
      navigationOrder,
      regionId: "row",
      getElement: () => null,
    });
  add("unordered");
  add("late", 20);
  add("first", 1);
  add("tie", 1);
  navigation.setFocus("first");
  assert.equal(navigation.moveFocus("right"), "tie");
  assert.equal(navigation.moveFocus("right"), "late");
  assert.equal(navigation.moveFocus("right"), "unordered");
  navigation.updateNavigationNode("unordered", { navigationOrder: 0 });
  navigation.setFocus("unordered");
  assert.equal(navigation.moveFocus("right"), "first");
  navigation.updateNavigationNode("tie", { navigationState: "disabled" });
  assert.equal(navigation.moveFocus("right"), "late");
});

test("restores focus when a modal closes and resolves a pending focus request", () => {
  const navigation = setup();
  navigation.registerNavigationNode({
    id: "other",
    regionId: "row",
    getElement: () => null,
  });
  navigation.requestFocusWhenAvailable("wanted");
  const removeWanted = navigation.registerNavigationNode({
    id: "wanted",
    regionId: "row",
    getElement: () => null,
  });
  assert.equal(navigation.getCurrentFocusId(), "wanted");
  const close = navigation.registerLayer({ id: "modal" });
  const removeRegion = navigation.registerRegion({
    id: "modal-row",
    parentRegionId: null,
    layerId: "modal",
    orientation: "horizontal",
    getElement: () => null,
  });
  const removeNode = navigation.registerNavigationNode({
    id: "modal-button",
    regionId: "modal-row",
    getElement: () => null,
  });
  assert.equal(navigation.getCurrentFocusId(), "modal-button");
  removeNode();
  removeRegion();
  close();
  assert.equal(navigation.getCurrentFocusId(), "wanted");
  removeWanted();
  assert.equal(navigation.getCurrentFocusId(), "other");
});

test("focus changes preserve structural snapshots and unsubscription cancels delivery", async () => {
  const navigation = setup();
  for (const id of ["a", "b"])
    navigation.registerNavigationNode({
      id,
      regionId: "row",
      getElement: () => null,
    });
  await Promise.resolve();
  const nodes = navigation.getNodes();
  const regions = navigation.getRegions();
  const layers = navigation.getLayers();
  let notifications = 0;
  const unsubscribe = navigation.subscribe(() => notifications++);
  navigation.setFocus("b");
  unsubscribe();
  await Promise.resolve();
  assert.equal(notifications, 0);
  assert.equal(navigation.getNodes(), nodes);
  assert.equal(navigation.getRegions(), regions);
  assert.equal(navigation.getLayers(), layers);
});

test("a persistent region remount retains navigation after parent-first cleanup", () => {
  const navigation = new NavigationService();
  const mount = () => {
    const removeRegion = navigation.registerRegion({
      id: "row",
      parentRegionId: null,
      orientation: "horizontal",
      isPersistent: true,
      getElement: () => null,
    });
    const removeA = navigation.registerNavigationNode({
      id: "a",
      regionId: "row",
      getElement: () => null,
    });
    const removeB = navigation.registerNavigationNode({
      id: "b",
      regionId: "row",
      getElement: () => null,
    });
    return () => {
      removeRegion();
      removeA();
      removeB();
    };
  };
  const unmount = mount();
  assert.equal(navigation.moveFocus("right"), "b");
  unmount();
  const nextUnmount = mount();
  assert.equal(navigation.moveFocus("right"), "b");
  nextUnmount();
});
