package main

import "fmt"

// Shape is anything with a measurable area.
type Shape interface {
	Area() float64
	Describe() string
}

// Pi is good enough for the demo.
const Pi = 3.14159

// Circle implements Shape.
type Circle struct {
	Radius float64
}

func (c Circle) Area() float64 {
	return Pi * c.Radius * c.Radius
}

func (c Circle) Describe() string {
	return fmt.Sprintf("area=%.2f", c.Area())
}

func defaultShape() Shape {
	return Circle{Radius: 1}
}
