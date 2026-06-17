package fixtures

/** A 2-D shape. */
interface Shape {
    fun area(): Double
}

/** A circle with a radius. */
data class Circle(val radius: Double) : Shape {
    override fun area(): Double {
        return radius * radius * 3
    }

    fun describe(): String {
        return "circle"
    }
}

/** The kinds of shape we render. */
enum class Kind {
    ROUND,
    POINTED
}

/** Builds a label for a circle (extension function). */
fun Circle.label(): String {
    return describe()
}

fun defaultCircle(): Circle {
    return Circle(1.0)
}
