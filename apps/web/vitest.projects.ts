// 单测分流规则的唯一来源：根 runner 与单包 vitest 共用，改一处两边生效。
// alias 与测试文件的相对前缀由调用方给定（根目录与单包 cwd 不同）。
export function dashboardTestProjects(alias: Record<string, string>, srcGlob: string) {
  return [
    {
      resolve: { alias },
      test: {
        name: "node",
        include: [`${srcGlob}/**/*.test.ts`],
        environment: "node",
      },
    },
    {
      resolve: { alias },
      test: {
        name: "dom",
        include: [`${srcGlob}/**/*.test.tsx`],
        environment: "jsdom",
        setupFiles: [`${srcGlob}/test-setup.ts`],
      },
    },
  ];
}
