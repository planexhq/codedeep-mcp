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
    name: 'swift-argument-parser',
    url: 'https://github.com/apple/swift-argument-parser.git',
    lang: 'swift',
    dimension: 'Swift baseline (small/idiomatic): struct/enum/protocol-dense, extensions methods-apart, computed properties, init resolution, internal-default exportedness',
  },
  {
    name: 'alamofire',
    url: 'https://github.com/Alamofire/Alamofire.git',
    lang: 'swift',
    dimension: 'Swift networking lib: class/protocol/extension density, closures descended, property observers, construction-as-call (Type()) edges',
  },
  {
    name: 'swift-nio',
    url: 'https://github.com/apple/swift-nio.git',
    lang: 'swift',
    dimension: 'Swift scale: large multi-module, generics/inout-heavy, actors, deep protocol/extension hierarchies',
  },
  {
    name: 'vapor',
    url: 'https://github.com/vapor/vapor.git',
    lang: 'swift',
    dimension: 'Swift server framework: protocol/extension-heavy, result builders, async/throws, property wrappers',
  },
  {
    name: 'okio',
    url: 'https://github.com/square/okio.git',
    lang: 'kotlin',
    dimension: 'Kotlin baseline (idiomatic lib): extension functions methods-apart, companion objects, sealed classes, internal-default exportedness, multiplatform expect/actual',
  },
  {
    name: 'moshi',
    url: 'https://github.com/square/moshi.git',
    lang: 'kotlin',
    dimension: 'Kotlin + codegen: data classes, companion-object factories, sealed adapters, mixed .kt/.java coexistence, primary-ctor val properties',
  },
  {
    name: 'kotlinx-serialization',
    url: 'https://github.com/Kotlin/kotlinx.serialization.git',
    lang: 'kotlin',
    dimension: 'sealed-class hierarchies, @Serializable annotation density, companion-object factories, construction-heavy (1684 class-target bare resolutions), object serializers',
  },
  {
    name: 'koin',
    url: 'https://github.com/InsertKoinIO/koin.git',
    lang: 'kotlin',
    dimension: 'DI DSL: module {} lambda-with-receiver builders, reified inline funcs, scope functions, mixed .kt/.java',
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
  {
    name: 'equatable',
    url: 'https://github.com/felangel/equatable.git',
    ref: 'v2.0.8',
    lang: 'dart',
    dimension: 'Dart baseline (tiny idiomatic lib): EquatableMixin mixin-merged members, operator== overloads, abstract base classes, leading-underscore privacy, hand-verifiable density',
  },
  {
    name: 'built_value',
    url: 'https://github.com/google/built_value.dart.git',
    ref: 'v8.12.6',
    lang: 'dart',
    dimension: 'named/factory constructors (Foo._() / factory Foo), enhanced enum classes (EnumClass), immutable value types + Builder classes, codegen-heavy',
  },
  {
    name: 'http',
    url: 'https://github.com/dart-lang/http.git',
    lang: 'dart',
    dimension: 'async/generics-heavy: Future/Stream, abstract interface class, generic BaseClient/Request hierarchy, construction-as-call (Request(), Response()) edges',
  },
  {
    name: 'getx',
    url: 'https://github.com/jonataslaw/getx.git',
    ref: '4.6.1',
    lang: 'dart',
    dimension: 'Flutter widget-heavy: Widget(...) construction -> class resolution, GetBuilder/Obx builder patterns, cascade (..) chains, extension methods on context, arrow-closure callbacks',
  },
  {
    name: 'dio',
    url: 'https://github.com/cfug/dio.git',
    lang: 'dart',
    dimension: 'async HTTP client: Options()/RequestOptions() construction edges, interceptor builder cascades (Dio()..interceptors.add(..)), generic Response<T>, monorepo packages/ layout',
  },
  {
    name: 'dapper',
    url: 'https://github.com/DapperLib/Dapper.git',
    lang: 'csharp',
    dimension: 'C# baseline (tiny, hand-verifiable): extension methods on IDbConnection keyed methods-apart, static-heavy, partial classes, generics, internal-default exportedness',
  },
  {
    name: 'newtonsoft-json',
    url: 'https://github.com/JamesNK/Newtonsoft.Json.git',
    lang: 'csharp',
    dimension: 'C# density baseline: classes/structs/properties, nested types, JsonConvert static API, attribute-decorated members, #if conditional compilation',
  },
  {
    name: 'polly',
    url: 'https://github.com/App-vNext/Polly.git',
    lang: 'csharp',
    dimension: 'resilience lib: fluent builder patterns, generics-heavy delegates, lambdas descended, records, construction-as-call (new Policy()) edges',
  },
  {
    name: 'fluentvalidation',
    url: 'https://github.com/FluentValidation/FluentValidation.git',
    lang: 'csharp',
    dimension: 'validation fluent API: chained-call blind spot (RuleFor().NotNull()), nested lambdas, extension methods, generic constraint rules',
  },
  {
    name: 'serilog',
    url: 'https://github.com/serilog/serilog.git',
    lang: 'csharp',
    dimension: 'structured logging: fluent LoggerConfiguration builders, extension methods on ILogger, sealed sinks, interface-heavy, params/optional args',
  },
  {
    name: 'automapper',
    url: 'https://github.com/AutoMapper/AutoMapper.git',
    lang: 'csharp',
    dimension: 'object mapper: reflection/expression-tree heavy, deep generics (IMapper<TSrc,TDest>), nested config classes, conversion operators, partial classes',
  },
];

export function reposByName(names: string[]): RepoSpec[] {
  const set = new Set(names);
  return REPOS.filter((r) => set.has(r.name));
}
