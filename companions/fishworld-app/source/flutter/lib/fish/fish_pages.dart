import 'package:flutter/material.dart';

import '../sidebar.dart';
import 'fish_collections.dart';
import 'fish_diary.dart';
import 'fish_growth.dart';
import 'fish_memory.dart';
import 'fish_overview.dart';
import 'fish_profile.dart';
import 'fish_qq.dart';
import 'fish_status.dart';
import 'fish_wishes.dart';

/// 鱼的世界页面出口：pages.dart 只认这一个入口，新增鱼页不用再改路由表。
///
/// 返回 null 表示「不是鱼的世界路由」，交给 pages.dart 里原有的页面。
Widget? fishPageFor(NavRoute route) {
  switch (route) {
    case NavRoute.overview:
      return const FishOverviewPage();
    case NavRoute.diary:
      return const FishDiaryPage();
    case NavRoute.wish:
      return const FishWishesPage();
    case NavRoute.growth:
      return const FishGrowthPage();
    case NavRoute.memory:
      return const FishMemoryPage();
    case NavRoute.status:
      return const FishStatusPage();
    case NavRoute.collections:
    case NavRoute.gallery:
    case NavRoute.links:
      return const FishCollectionsPage();
    case NavRoute.profile:
      return const FishProfilePage();
    case NavRoute.platforms:
    case NavRoute.qq:
      return const FishPlatformsPage();
    default:
      return null;
  }
}
