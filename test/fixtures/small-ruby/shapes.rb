# Shape helpers — a module mixin and a couple of classes.
module Describable
  def describe
    "a #{kind} of area #{area}"
  end
end

class Shape
  include Describable

  def area
    0
  end

  def kind
    'shape'
  end
end

class Circle < Shape
  PI = 3.14159

  def initialize(radius)
    @radius = radius
  end

  def area
    PI * @radius * @radius
  end
end
