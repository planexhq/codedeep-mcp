package main

import "fmt"

func main() {
	g := NewGreeter("Hi")
	fmt.Println(g.Greet("probe"))
	fmt.Println(defaultShape().Describe())
}
