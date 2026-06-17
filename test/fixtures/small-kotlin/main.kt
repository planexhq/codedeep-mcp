package fixtures

fun main() {
    val g = Greeter("hello")
    println(g.greet("world"))
    println(normalize("trim me"))

    val c = defaultCircle()
    println(c.label())

    val d = Circle(2.0)
    println(d.area())
}
