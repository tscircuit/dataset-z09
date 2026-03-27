import { test } from "bun:test";
import { runForceDirectedImprovement } from "../lib/force-improve";
import { simplifyRoutes } from "../lib/simplify";
import sample from "../samples/sample000001.json";

const getBounds = () => ({
  minX: sample.center.x - sample.width / 2,
  maxX: sample.center.x + sample.width / 2,
  minY: sample.center.y - sample.height / 2,
  maxY: sample.center.y + sample.height / 2,
});

test("repeated single-step force improvement keeps sample000001 inside the box", () => {
  let routes = simplifyRoutes(sample.solution ?? []);

  for (let index = 0; index < 100; index += 1) {
    routes = runForceDirectedImprovement(sample, routes, 1).routes;
  }

  const bounds = getBounds();
  const offenders = routes.flatMap((route) => {
    const routePointOffenders = route.route
      .filter(
        (point) =>
          point.x < bounds.minX ||
          point.x > bounds.maxX ||
          point.y < bounds.minY ||
          point.y > bounds.maxY,
      )
      .map((point) => ({
        kind: "route-point",
        connectionName: route.connectionName,
        ...point,
      }));

    const viaOffenders = route.vias
      .filter(
        (via) =>
          via.x < bounds.minX ||
          via.x > bounds.maxX ||
          via.y < bounds.minY ||
          via.y > bounds.maxY,
      )
      .map((via) => ({
        kind: "via",
        connectionName: route.connectionName,
        ...via,
      }));

    return [...routePointOffenders, ...viaOffenders];
  });

  if (offenders.length > 0) {
    throw new Error(
      `Found ${offenders.length} out-of-bounds points after 100 steps:\n${JSON.stringify(
        offenders.slice(0, 10),
        null,
        2,
      )}`,
    );
  }
});

test("force vectors are emitted for points and vias only", () => {
  const routes = simplifyRoutes(sample.solution ?? []);
  const result = runForceDirectedImprovement(sample, routes, 1);
  const invalidKinds = result.forceVectors.filter(
    (forceVector) =>
      forceVector.kind !== "point" && forceVector.kind !== "via",
  );

  if (invalidKinds.length > 0) {
    throw new Error(
      `Unexpected force vector kinds:\n${JSON.stringify(
        invalidKinds.slice(0, 10),
        null,
        2,
      )}`,
    );
  }
});
