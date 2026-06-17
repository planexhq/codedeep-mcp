<?php

namespace Sample;

/** Greets people by name. */
class Greeter
{
    private string $name;

    public function __construct(string $name)
    {
        $this->name = $name;
    }

    /** Returns a greeting. */
    public function greet(): string
    {
        return $this->format();
    }

    private function format(): string
    {
        return normalize($this->name);
    }

    public function summary(): string
    {
        return $this->describe();
    }

    public function describe(): string
    {
        return $this->name;
    }
}

/** Normalizes a string (free function). */
function normalize(string $s): string
{
    return trim($s);
}
