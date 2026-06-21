#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@protocol Shape <NSObject>
- (double)area;
@end

// A circle, parameterized by its radius.
@interface Circle : NSObject <Shape>
- (instancetype)initWithRadius:(double)radius;
- (double)area;
@end

NS_ASSUME_NONNULL_END
