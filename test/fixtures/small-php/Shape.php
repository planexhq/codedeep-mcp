<?php

namespace Sample;

interface Shape
{
    public function area(): float;
}

trait Tagged
{
    public function tag(): string
    {
        return 'shape';
    }
}

class Circle implements Shape
{
    use Tagged;

    public function __construct(private float $radius) {}

    public function area(): float
    {
        return 3.14 * $this->radius * $this->radius;
    }

    public function label(): string
    {
        return 'circle';
    }
}

/** Factory: construction edge to Circle. */
function defaultCircle(): Circle
{
    return new Circle(1.0);
}
