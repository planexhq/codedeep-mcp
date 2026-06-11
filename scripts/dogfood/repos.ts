// Pinned manifest of real GitHub repos for the dogfooding campaign.
// Light + medium weight (heavyweight scale repos — microsoft/TypeScript,
// vscode — are deferred). Each entry names the dimension it stresses.
//
// Clones use --filter=blob:none (blobless partial clone): full commit +
// tree history (the git analyzer's `log --name-only` needs only those, no
// historical blobs) plus a working tree at HEAD — small download, real
// 180-day history for the behavioral oracle. `ref` pins a tag/branch;
// when absent the default branch HEAD is used and its SHA recorded.

export interface RepoSpec {
  name: string;
  url: string;
  ref?: string;
  lang: string;
  dimension: string;
}

export const REPOS: RepoSpec[] = [
  {
    name: 'ky',
    url: 'https://github.com/sindresorhus/ky.git',
    lang: 'typescript',
    dimension: 'tiny hand-verifiable TS baseline; arrow-const exports; export * barrel',
  },
  {
    name: 'zod',
    url: 'https://github.com/colinhacks/zod.git',
    lang: 'typescript',
    dimension: 'fluent method chaining (.min().email()) -> chained-call blind spot; barrel re-exports; huge inferred signatures',
  },
  {
    name: 'requests',
    url: 'https://github.com/psf/requests.git',
    lang: 'python',
    dimension: 'Python baseline; __all__ exportedness; Session class + self.x() calls',
  },
  {
    name: 'flask',
    url: 'https://github.com/pallets/flask.git',
    lang: 'python',
    dimension: 'decorators-as-callrefs (@app.route); class-based views',
  },
  {
    name: 'express',
    url: 'https://github.com/expressjs/express.git',
    lang: 'javascript',
    dimension: 'member-call patterns (app.use, router.get, res.send); pattern-mode demo + caller flood',
  },
  {
    name: 'nest',
    url: 'https://github.com/nestjs/nest.git',
    lang: 'typescript',
    dimension: 'decorator + DI heavy; constructors not extracted; monorepo path aliases',
  },
  {
    name: 'fastapi',
    url: 'https://github.com/fastapi/fastapi.git',
    lang: 'python',
    dimension: 'decorator + type-hint heavy; async def; Depends()',
  },
  {
    name: 'trpc',
    url: 'https://github.com/trpc/trpc.git',
    lang: 'typescript',
    dimension: 'deep barrel re-exports across packages; TS path-mapping imports',
  },
  {
    name: 'gin',
    url: 'https://github.com/gin-gonic/gin.git',
    lang: 'go',
    dimension: 'UNSUPPORTED language -> scanned, zero symbols; Other-files accuracy; pattern-mode refusal',
  },
  {
    name: 'gson',
    url: 'https://github.com/google/gson.git',
    lang: 'java',
    dimension: 'plain-Java baseline: extraction density, implicit-this resolution rate, overloads, Maven target/ exclusion',
  },
  {
    name: 'junit5',
    url: 'https://github.com/junit-team/junit5.git',
    lang: 'java',
    dimension: 'nested-class recursion (@Nested), annotation-heavy signatures, interfaces with default methods, Gradle monorepo',
  },
];

export function reposByName(names: string[]): RepoSpec[] {
  const set = new Set(names);
  return REPOS.filter((r) => set.has(r.name));
}
