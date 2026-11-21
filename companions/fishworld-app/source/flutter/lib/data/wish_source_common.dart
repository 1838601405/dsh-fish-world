import 'package:flutter/material.dart';

import 'wish_source.dart' as impl;

class WishThumb extends StatelessWidget {
  final String id;
  final String file;
  final List<String> roots;
  const WishThumb({super.key, required this.id, required this.file, required this.roots});
  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final p = impl.wishImageProvider(id, file, roots);
    if (p == null) return _ph(scheme, file);
    return Image(image: p, fit: BoxFit.cover, errorBuilder: (_, __, ___) => _ph(scheme, file));
  }
  Widget _ph(ColorScheme scheme, String file) => Container(
        color: scheme.onSurface.withValues(alpha: .06),
        child: Icon(Icons.image_not_supported_outlined, size: 18, color: scheme.onSurfaceVariant),
      );
}

Future<Map<String, dynamic>> loadWishes(List<String> roots) => impl.stickerWishesLoad(roots);
bool get wishCanDecide => impl.wishCanDecide;
