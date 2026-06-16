package main

// Greeter greets people with a configurable prefix.
type Greeter struct {
	prefix string
}

// NewGreeter builds a Greeter with the given prefix.
func NewGreeter(prefix string) *Greeter {
	return &Greeter{prefix: prefix}
}

// Greet returns the greeting for one person.
func (g *Greeter) Greet(name string) string {
	return g.format(name)
}

func (g *Greeter) format(name string) string {
	return g.prefix + ", " + name + "!"
}
