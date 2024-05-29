#!/usr/bin/env python3

from math import asin, cos, radians, sin, sqrt


def distance_between_two_points(lat1, lon1, lat2, lon2):
    # Convert latitude and longitude to radians
    lat1, lon1, lat2, lon2 = map(radians, [lat1, lon1, lat2, lon2])

    # Calculate the differences in longitude and latitude
    dlon = lon2 - lon1
    dlat = lat2 - lat1

    # Calculate the Haversine formula
    a = sin(dlat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(dlon / 2) ** 2
    c = 2 * asin(sqrt(a))
    radius = 6371  # Radius of Earth in kilometers
    distance = radius * c  # Distance in kilometers

    return distance
