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
    dimension: 'Go baseline: receiver self-call resolution, composite-literal refs, capitalization exportedness, builtin filtering, same-package carve-out',
  },
  {
    name: 'cobra',
    url: 'https://github.com/spf13/cobra.git',
    lang: 'go',
    dimension: 'light Go CLI lib: method-heavy Command type, _test.go files indexed, grouped const/var blocks',
  },
  {
    name: 'fd',
    url: 'https://github.com/sharkdp/fd.git',
    lang: 'rust',
    dimension: 'Rust baseline: impl-block methods, self/Self/Type:: resolution, struct-expression ctors, trait impls, modules, Some/Ok/Err filtering',
  },
  {
    name: 'ripgrep',
    url: 'https://github.com/BurntSushi/ripgrep.git',
    lang: 'rust',
    dimension: 'Rust workspace scale: multi-crate modules, trait/impl-heavy, crate:: multi-segment path-call cross-file recall, ~4k symbols',
  },
  {
    name: 'serde',
    url: 'https://github.com/serde-rs/serde.git',
    lang: 'rust',
    dimension: 'Rust proc-macro/derive heavy: trait-dense, declaration-only crates, generic bounds, associated types/consts',
  },
  {
    name: 'sinatra',
    url: 'https://github.com/sinatra/sinatra.git',
    lang: 'ruby',
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
  {
    name: 'commons-lang',
    url: 'https://github.com/apache/commons-lang.git',
    lang: 'java',
    dimension: 'light plain-Java baseline: static-util overloads, hand-verifiable density',
  },
  {
    name: 'guava',
    url: 'https://github.com/google/guava.git',
    lang: 'java',
    dimension: 'generics-heavy: Multimap/Immutable* signatures, builder pattern, nested static types',
  },
  {
    name: 'spring-petclinic',
    url: 'https://github.com/spring-projects/spring-petclinic.git',
    lang: 'java',
    dimension: 'annotation/DI (@RestController/@Service/@Autowired), constructor injection, hand-verifiable Spring layout',
  },
  {
    name: 'rxjava',
    url: 'https://github.com/ReactiveX/RxJava.git',
    lang: 'java',
    dimension: 'fluent chaining (Observable.x().y()) -> chained-call blind spot; deep generics; operator-heavy base classes',
  },
  {
    name: 'netty',
    url: 'https://github.com/netty/netty.git',
    lang: 'java',
    dimension: 'industrial scale (Maven multi-module), deep handler/channel hierarchies, generic channel types',
  },
  {
    name: 'jackson-databind',
    url: 'https://github.com/FasterXML/jackson-databind.git',
    lang: 'java',
    dimension: 'annotation-refs (@JsonProperty/@JsonCreator), reflection-heavy, generic TypeReference',
  },
];

export function reposByName(names: string[]): RepoSpec[] {
  const set = new Set(names);
  return REPOS.filter((r) => set.has(r.name));
}
